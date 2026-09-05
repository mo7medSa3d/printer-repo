package printer

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"
)

// DiscoveryCandidate describes a device found by an automatic discovery
// mechanism. Discovery origin and verification state are deliberately separate.
type DiscoveryCandidate struct {
	Device       DeviceInfo `json:"device"`
	Confidence   string     `json:"confidence"`
	Verification string     `json:"verification"`
	Sources      []string   `json:"sources"`
}

const (
	SourceMDNS     = "mdns"
	SourceIPP      = "ipp"
	SourceIPPS     = "ipps"
	SourceRAW      = "raw"
	SourceLPR      = "lpr"
	SourceSNMP     = "snmp"
	SourceWSD      = "wsd"
	SourceSpooler  = "windows_spooler"
	SourceUSB      = "usb"
	SourceSubnet   = "subnet"
	SourceConfig   = "config"
	SourceRegistry = "registry"
)

func confidenceForDevice(sources []string, verification string, manufacturer, model string) string {
	hasVerified := verification == "verified"
	if hasVerified && (containsDiscoverySource(sources, SourceIPP) || containsDiscoverySource(sources, SourceIPPS) || containsDiscoverySource(sources, SourceSpooler)) {
		return "high"
	}
	if len(sources) >= 2 && manufacturer != "" && model != "" {
		return "high"
	}
	if hasVerified || len(sources) >= 2 || (manufacturer != "" && model != "") {
		return "medium"
	}
	return "low"
}

func containsDiscoverySource(sources []string, want string) bool {
	for _, source := range sources {
		if source == want {
			return true
		}
	}
	return false
}

func dedupeKey(di DeviceInfo) string {
	if di.Capabilities != nil {
		for _, key := range []string{"uuid", "printer_uuid"} {
			if value := strings.TrimSpace(fmt.Sprint(di.Capabilities[key])); value != "" && value != "<nil>" {
				return "uuid:" + strings.ToLower(value)
			}
		}
		if value := strings.TrimSpace(fmt.Sprint(di.Capabilities["mac"])); value != "" && value != "<nil>" {
			return "mac:" + strings.ToLower(value)
		}
	}
	if di.USBSerial != "" {
		return fmt.Sprintf("usb:%s:%s:%s", strings.ToLower(di.USBVID), strings.ToLower(di.USBPID), strings.ToLower(di.USBSerial))
	}
	if di.NetworkAddress != "" && di.Port != 0 {
		return fmt.Sprintf("ip:%s:%d", strings.ToLower(di.NetworkAddress), di.Port)
	}
	if di.SpoolerName != "" {
		return "spooler:" + strings.ToLower(di.SpoolerName)
	}
	if di.NetworkAddress != "" {
		return "ip:" + strings.ToLower(di.NetworkAddress)
	}
	return "id:" + di.ID
}

func addVerification(caps map[string]interface{}, verification, confidence, source string) map[string]interface{} {
	if caps == nil {
		caps = make(map[string]interface{})
	}
	caps["verification"] = verification
	caps["confidence"] = confidence
	caps["discovery_source"] = source
	return caps
}

// candidateDevice keeps transport details in the capability bag for diagnostics,
// while omitting them from DeviceInfo so the central classifier cannot promote an
// unverified network observation to a production printer.
func candidateDevice(id, name, displayName, source, confidence string, caps map[string]interface{}) DeviceInfo {
	return DeviceInfo{
		ID:             id,
		Name:           name,
		DisplayName:    displayName,
		PrinterType:    "unknown",
		ConnectionType: "network",
		Protocol:       "raw",
		Status:         "unknown",
		Enabled:        true,
		Type:           "network",
		Capabilities:   addVerification(caps, "candidate", confidence, source),
	}
}

func discoverSNMPPrinters(ctx context.Context, targets []string) []DeviceInfo {
	if len(targets) == 0 { return nil }
	const workers = 16
	const perHostTimeout = 1500 * time.Millisecond
	jobs := make(chan string, len(targets))
	results := make(chan DeviceInfo, len(targets))
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for host := range jobs {
				if ctx.Err() != nil { return }
				if di := probeSNMPHost(ctx, host, perHostTimeout); di != nil {
					select { case results <- *di: case <-ctx.Done(): return }
				}
			}
		}()
	}
	for _, target := range targets {
		select { case jobs <- target: case <-ctx.Done(): break }
	}
	close(jobs)
	wg.Wait()
	close(results)
	out := make([]DeviceInfo, 0)
	seen := make(map[string]bool)
	for di := range results {
		key := dedupeKey(di)
		if seen[key] { continue }
		seen[key] = true
		out = append(out, di)
	}
	return out
}

func probeSNMPHost(ctx context.Context, host string, timeout time.Duration) *DeviceInfo {
	packet := buildSNMPGet([]string{"1.3.6.1.2.1.1.1.0", "1.3.6.1.2.1.1.5.0"})
	addr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(host, "161"))
	if err != nil { return nil }
	conn, err := net.DialUDP("udp", nil, addr)
	if err != nil { return nil }
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))
	if _, err := conn.Write(packet); err != nil { return nil }
	buf := make([]byte, 2048)
	n, err := conn.Read(buf)
	if err != nil { return nil }
	sysDescr := extractSNMPString(buf[:n])
	if sysDescr == "" { return nil }
	lower := strings.ToLower(sysDescr)
	isPrinter := strings.Contains(lower, "printer") || strings.Contains(lower, "jetdirect") || strings.Contains(lower, "laser") || strings.Contains(lower, "zebra") || strings.Contains(lower, "epson") || strings.Contains(lower, "brother") || (strings.Contains(lower, "hp") && strings.Contains(lower, "print"))
	if !isPrinter && !strings.Contains(lower, "print") { return nil }
	caps := map[string]interface{}{"discovered_via":"snmp","discovery_protocol":"snmp","sysDescr":sysDescr,"candidate_host":host,"candidate_port":9100}
	if parts := strings.Fields(sysDescr); len(parts) >= 2 { caps["manufacturer"] = parts[0] }
	d := candidateDevice(StableIDFromNetwork(host, 9100), fmt.Sprintf("SNMP Printer %s", host), sysDescr, SourceSNMP, "medium", caps)
	return &d
}

func buildSNMPGet(oids []string) []byte {
	var pduContent bytes.Buffer
	pduContent.Write([]byte{0x02,0x04,0,0,0,1})
	pduContent.Write([]byte{0x02,0x01,0})
	pduContent.Write([]byte{0x02,0x01,0})
	varbinds := bytes.Buffer{}
	for _, oid := range oids {
		oidBytes := encodeOID(oid)
		if len(oidBytes)==0 { continue }
		var vb bytes.Buffer
		vb.WriteByte(0x06); writeBERLength(&vb,len(oidBytes)); vb.Write(oidBytes); vb.Write([]byte{0x05,0})
		varbinds.WriteByte(0x30); writeBERLength(&varbinds,vb.Len()); varbinds.Write(vb.Bytes())
	}
	pduContent.WriteByte(0x30); writeBERLength(&pduContent,varbinds.Len()); pduContent.Write(varbinds.Bytes())
	var pdu bytes.Buffer
	pdu.WriteByte(0xA0); writeBERLength(&pdu,pduContent.Len()); pdu.Write(pduContent.Bytes())
	var msg bytes.Buffer
	body := bytes.Buffer{}
	body.Write([]byte{0x02,0x01,0}); body.Write([]byte{0x04,0x06}); body.WriteString("public"); body.Write(pdu.Bytes())
	msg.WriteByte(0x30); writeBERLength(&msg,body.Len()); msg.Write(body.Bytes())
	return msg.Bytes()
}

func writeBERLength(buf *bytes.Buffer, n int) {
	if n < 0 { return }
	if n < 128 { buf.WriteByte(byte(n)); return }
	var tmp [8]byte; i:=len(tmp)
	for n>0 { i--; tmp[i]=byte(n); n >>= 8 }
	buf.WriteByte(0x80|byte(len(tmp)-i)); buf.Write(tmp[i:])
}

func encodeOID(s string) []byte {
	parts:=strings.Split(strings.TrimSpace(s),"."); if len(parts)<2{return nil}
	values:=make([]int,len(parts)); for i,p:=range parts { if _,err:=fmt.Sscanf(p,"%d",&values[i]);err!=nil||values[i]<0{return nil} }
	if values[0]>2||(values[0]<2&&values[1]>=40){return nil}
	out:=make([]byte,0,len(parts)); appendBase128:=func(v int){if v==0{out=append(out,0);return};var tmp [8]byte;i:=len(tmp);for v>0{i--;tmp[i]=byte(v&0x7f);v>>=7};for j:=i;j<len(tmp)-1;j++{out=append(out,tmp[j]|0x80)};out=append(out,tmp[len(tmp)-1])}
	appendBase128(values[0]*40+values[1]); for _,v:=range values[2:]{appendBase128(v)}
	return out
}

func extractSNMPString(data []byte) string {
	targetOID:=encodeOID("1.3.6.1.2.1.1.1.0"); if len(targetOID)==0{return ""}
	for i:=0;i+len(targetOID)<len(data);i++ { if !bytes.Equal(data[i:i+len(targetOID)],targetOID){continue}; pos:=i+len(targetOID);if pos>=len(data)||data[pos]!=0x04{continue};length,next,ok:=readBERLength(data,pos+1);if !ok||length==0||length>512||next+length>len(data){continue};value:=data[next:next+length];for _,c:=range value{if c<32||c>126{return ""}};return string(value) }
	return ""
}

func readBERLength(data []byte,pos int)(length,next int,ok bool){if pos>=len(data){return 0,pos,false};first:=data[pos];pos++;if first&0x80==0{return int(first),pos,true};n:=int(first&0x7f);if n==0||n>4||pos+n>len(data){return 0,pos,false};var value int;for i:=0;i<n;i++{value=(value<<8)|int(data[pos+i])};return value,pos+n,true}

func discoverLPRPrinters(ctx context.Context, targets []string) []DeviceInfo {
	if len(targets)==0{return nil};const workers=16;const perHostTimeout=800*time.Millisecond;jobs:=make(chan string,len(targets));results:=make(chan DeviceInfo,len(targets));var wg sync.WaitGroup
	for i:=0;i<workers;i++{wg.Add(1);go func(){defer wg.Done();for host:=range jobs{if ctx.Err()!=nil{return};if di:=probeLPRHost(ctx,host,perHostTimeout);di!=nil{select{case results<-*di:case <-ctx.Done():return}}}}()}
	for _,target:=range targets{select{case jobs<-target:case <-ctx.Done():break}};close(jobs);wg.Wait();close(results)
	out:=make([]DeviceInfo,0);seen:=map[string]bool{};for di:=range results{key:=dedupeKey(di);if seen[key]{continue};seen[key]=true;out=append(out,di)};return out
}

func probeLPRHost(ctx context.Context,host string,timeout time.Duration)*DeviceInfo{
	d:=net.Dialer{Timeout:timeout};connCtx,cancel:=context.WithTimeout(ctx,timeout);defer cancel();conn,err:=d.DialContext(connCtx,"tcp",net.JoinHostPort(host,"515"));if err!=nil{return nil};defer conn.Close();_ = conn.SetDeadline(time.Now().Add(timeout));if _,err=conn.Write([]byte("\x04raw\n"));err!=nil{return nil};buf:=make([]byte,256);n,err:=conn.Read(buf);if err!=nil||n==0||buf[0]!=0x00{return nil};caps:=addVerification(map[string]interface{}{"discovered_via":"lpr","discovery_protocol":"lpr","lpr_verified":true,"queue":"raw"},"verified","high",SourceLPR);return &DeviceInfo{ID:StableIDFromNetwork(host,515),Name:fmt.Sprintf("LPR Printer %s",host),DisplayName:fmt.Sprintf("LPR Printer %s",host),PrinterType:"unknown",ConnectionType:"network",Protocol:"lpr",Endpoint:net.JoinHostPort(host,"515"),NetworkAddress:host,Port:515,Status:"online",Enabled:true,Type:"network",Capabilities:caps}
}

func discoverWSDPrinters(ctx context.Context) []DeviceInfo {
	probe:=buildWSDProbe();addr,err:=net.ResolveUDPAddr("udp4","239.255.255.250:3702");if err!=nil{return nil};conn,err:=net.DialUDP("udp4",nil,addr);if err!=nil{return nil};defer conn.Close();_ = conn.SetWriteDeadline(time.Now().Add(500*time.Millisecond));if _,err=conn.Write(probe);err!=nil{return nil};buf:=make([]byte,8192);out:=make([]DeviceInfo,0);seenIP:=map[string]bool{};deadline:=time.Now().Add(2*time.Second)
	for time.Now().Before(deadline)&&ctx.Err()==nil{_ = conn.SetReadDeadline(time.Now().Add(500*time.Millisecond));n,remote,err:=conn.ReadFromUDP(buf);if err!=nil{if ne,ok:=err.(net.Error);ok&&ne.Timeout(){continue};return out};lower:=strings.ToLower(string(buf[:n]));if !strings.Contains(lower,"print")&&!strings.Contains(lower,"printer")&&!strings.Contains(lower,"wprt"){continue};ip:=remote.IP.String();if seenIP[ip]{continue};seenIP[ip]=true;model:=extractXMLTag(string(buf[:n]),"wsdp:ModelName");if model==""{model=extractXMLTag(string(buf[:n]),"ModelName")};manufacturer:=extractXMLTag(string(buf[:n]),"wsdp:Manufacturer");if manufacturer==""{manufacturer=extractXMLTag(string(buf[:n]),"Manufacturer")};caps:=map[string]interface{}{"discovered_via":"wsd","discovery_protocol":"wsd","candidate_host":ip,"candidate_port":9100};if manufacturer!=""{caps["manufacturer"]=manufacturer};if model!=""{caps["model"]=model};name:=model;if name==""{name=fmt.Sprintf("WSD Printer %s",ip)};out=append(out,candidateDevice(StableIDFromNetwork(ip,9100),name,name,SourceWSD,"medium",caps))}
	return out
}

func buildWSDProbe() []byte {
	var id [16]byte;if _,err:=rand.Read(id[:]);err!=nil{binary.BigEndian.PutUint64(id[8:],uint64(time.Now().UnixNano()))};id[6]=(id[6]&0x0f)|0x40;id[8]=(id[8]&0x3f)|0x80;uuid:=fmt.Sprintf("urn:uuid:%08x-%04x-%04x-%04x-%012x",binary.BigEndian.Uint32(id[0:4]),binary.BigEndian.Uint16(id[4:6]),binary.BigEndian.Uint16(id[6:8]),binary.BigEndian.Uint16(id[8:10]),uint64(id[10])<<40|uint64(id[11])<<32|uint64(id[12])<<24|uint64(id[13])<<16|uint64(id[14])<<8|uint64(id[15]));return []byte(fmt.Sprintf(`<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:wsd="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:wprt="http://schemas.microsoft.com/windows/2006/08/wdp/print"><soap:Header><wsa:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</wsa:Action><wsa:MessageID>%s</wsa:MessageID><wsa:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</wsa:To></soap:Header><soap:Body><wsd:Probe><wsd:Types>wprt:PrintDeviceType</wsd:Types></wsd:Probe></soap:Body></soap:Envelope>`,uuid))
}

func extractXMLTag(s,tag string)string{start:=strings.Index(s,"<"+tag);if start<0{return ""};openEnd:=strings.IndexByte(s[start:],'>');if openEnd<0{return ""};valueStart:=start+openEnd+1;end:=strings.Index(s[valueStart:],"</"+tag+">");if end<0{return ""};return strings.TrimSpace(s[valueStart:valueStart+end])}

func discoverFullMDNS(ctx context.Context) []DeviceInfo { services:=[]string{"_ipp._tcp.local","_ipps._tcp.local","_printer._tcp.local"};addr,err:=net.ResolveUDPAddr("udp4","224.0.0.251:5353");if err!=nil{return nil};conn,err:=net.DialUDP("udp4",nil,addr);if err!=nil{return nil};defer conn.Close();for _,service:=range services{if q:=buildMDNSQueryReal(service);q!=nil{_ = conn.SetWriteDeadline(time.Now().Add(300*time.Millisecond));_,_=conn.Write(q)}};buf:=make([]byte,8192);deadline:=time.Now().Add(2*time.Second);seen:=map[string]bool{};out:=make([]DeviceInfo,0);for time.Now().Before(deadline)&&ctx.Err()==nil{_ = conn.SetReadDeadline(time.Now().Add(500*time.Millisecond));n,_,err:=conn.ReadFromUDP(buf);if err!=nil{if ne,ok:=err.(net.Error);ok&&ne.Timeout(){continue};return out};for _,host:=range parseMDNSHosts(buf[:n]){port:=host.Port;if port==0{port=631};key:=fmt.Sprintf("%s:%d",host.IP,port);if seen[key]{continue};seen[key]=true;caps:=map[string]interface{}{"discovered_via":"mdns","discovery_protocol":"mdns","candidate_host":host.IP,"candidate_port":port};if host.Model!=""{caps["model"]=host.Model};if host.Manufacturer!=""{caps["manufacturer"]=host.Manufacturer};if host.UUID!=""{caps["uuid"]=host.UUID};name:=host.Name;if name==""{name=fmt.Sprintf("mDNS Printer %s",host.IP)};id:=StableIDFromNetwork(host.IP,port);if host.UUID!=""{id=StableIDFromUUID(host.UUID)};out=append(out,candidateDevice(id,name,name,SourceMDNS,"medium",caps))}};return out }

type mdnsHost struct{IP string;Port int;Name string;Model string;Manufacturer string;UUID string}

func buildMDNSQueryReal(service string) []byte {service=strings.TrimSuffix(strings.TrimSpace(service),".");if service==""{return nil};var buf bytes.Buffer;binary.Write(&buf,binary.BigEndian,uint16(0));binary.Write(&buf,binary.BigEndian,uint16(0));binary.Write(&buf,binary.BigEndian,uint16(1));binary.Write(&buf,binary.BigEndian,uint16(0));binary.Write(&buf,binary.BigEndian,uint16(0));binary.Write(&buf,binary.BigEndian,uint16(0));for _,part:=range strings.Split(service,"."){if len(part)>63{return nil};buf.WriteByte(byte(len(part)));buf.WriteString(part)};buf.WriteByte(0);binary.Write(&buf,binary.BigEndian,uint16(12));binary.Write(&buf,binary.BigEndian,uint16(1));return buf.Bytes()}

func parseMDNSHosts(data []byte) []mdnsHost {s:=string(data);model:="";if idx:=strings.Index(strings.ToLower(s),"product=");idx>=0{start:=idx+len("product=");end:=strings.IndexByte(s[start:],0);if end<0{end=strings.IndexByte(s[start:], '\n')};if end<0{end=len(s)-start};model=strings.TrimSpace(s[start:start+end])};uuid:="";if idx:=strings.Index(strings.ToLower(s),"uuid=");idx>=0{start:=idx+len("uuid=");end:=strings.IndexByte(s[start:],0);if end<0{end=64;if start+end>len(s){end=len(s)-start}};uuid=strings.TrimSpace(s[start:start+end])};for i:=0;i+6<=len(data);i++{if data[i]!=0x00||data[i+1]!=0x04{continue};ip:=net.IPv4(data[i+2],data[i+3],data[i+4],data[i+5]);if ip.IsPrivate()&&!ip.IsLoopback(){return []mdnsHost{{IP:ip.String(),Model:model,UUID:uuid}}}};return nil}

func isAllowedCIDR(cidr string) bool {if cidr==""{return false};_,ipnet,err:=net.ParseCIDR(cidr);if err!=nil||ipnet==nil{return false};if !ipnet.IP.IsPrivate()||ipnet.IP.IsLoopback(){return false};ones,bits:=ipnet.Mask.Size();return bits==32&&ones>=16&&ones<=30}
