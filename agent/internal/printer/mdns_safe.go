package printer

import (
	"context"
	"encoding/binary"
	"fmt"
	"log"
	"net"
	"strings"
	"sync"
	"time"
)

func discoverMDNSPrintersSafe(ctx context.Context) ([]DeviceInfo, error) {
	services := []string{"_ipp._tcp.local.", "_ipps._tcp.local.", "_print._sub._ipp._tcp.local.", "_print._sub._ipps._tcp.local."}
	if ctx == nil { ctx = context.Background() }
	ctx, cancel := context.WithTimeout(ctx, 4500*time.Millisecond)
	defer cancel()
	ifaces, err := mdnsInterfaces()
	if err != nil { return nil, err }
	if len(ifaces) == 0 { return nil, fmt.Errorf("no multicast-capable IPv4 interfaces") }

	type answer struct { devices []DeviceInfo; err error }
	answers := make(chan answer, len(ifaces))
	var wg sync.WaitGroup
	for _, iface := range ifaces {
		iface := iface
		wg.Add(1)
		go func(){ defer wg.Done(); d,e:=browseMDNSServicesExact(ctx,iface,services); answers<-answer{d,e} }()
	}
	go func(){ wg.Wait(); close(answers) }()
	seen:=map[string]bool{}
	var out []DeviceInfo
	var errs []string
	for a:=range answers {
		if a.err!=nil { errs=append(errs,a.err.Error()) }
		for _,d:=range a.devices { key:=strings.ToLower(fmt.Sprintf("%s:%d",d.NetworkAddress,d.Port)); if seen[key]{continue}; seen[key]=true; out=append(out,d) }
	}
	if len(errs)>0&&len(out)==0 { return out,fmt.Errorf("mDNS discovery: %s",strings.Join(errs,"; ")) }
	return out,nil
}

func browseMDNSServicesExact(ctx context.Context, iface *net.Interface, services []string) ([]DeviceInfo,error) {
	conn,err:=net.ListenMulticastUDP("udp4",iface,&net.UDPAddr{IP:net.ParseIP(mdnsIPv4),Port:mdnsPort}); if err!=nil{return nil,err}; defer conn.Close()
	for _,service:=range services { q,e:=buildMDNSPTRQuery(service); if e!=nil{return nil,e}; _=conn.SetWriteDeadline(time.Now().Add(500*time.Millisecond)); if _,e=conn.WriteToUDP(q,&net.UDPAddr{IP:net.ParseIP(mdnsIPv4),Port:mdnsPort});e!=nil{log.Printf("[discovery] mDNS query on %s: %v",iface.Name,e)} }

	var records []mdnsRecord
	buf:=make([]byte,9000)
	readUntil:=func(deadline time.Time){
		for time.Now().Before(deadline)&&ctx.Err()==nil{
			_ = conn.SetReadDeadline(time.Now().Add(100*time.Millisecond)); n,_,e:=conn.ReadFromUDP(buf)
			if e!=nil { if ne,ok:=e.(net.Error);ok&&ne.Timeout(){continue}; return }
			records=append(records,parseMDNSPacket(buf[:n])...)
		}
	}
	readUntil(time.Now().Add(1200*time.Millisecond))

	serviceSet:=map[string]bool{}; for _,s:=range services{serviceSet[strings.ToLower(trimFQDN(s))]=true}
	type entry struct{service string;srv *mdnsSRV;txt map[string]string;ips []net.IP}
	instances:=map[string]*entry{}
	for _,rr:=range records{if rr.type_!=12||rr.ptr==""||!serviceSet[strings.ToLower(trimFQDN(rr.name))]{continue};key:=strings.ToLower(trimFQDN(rr.ptr));e:=instances[key];if e==nil{e=&entry{txt:map[string]string{}};instances[key]=e};e.service=strings.ToLower(trimFQDN(rr.name))}

	for _,rr:=range records{e:=instances[strings.ToLower(trimFQDN(rr.name))];if e==nil{continue};switch rr.type_{case 33:if rr.srv!=nil{e.srv=rr.srv};case 16:for k,v:=range rr.txt{e.txt[k]=v}}}

	// RFC 6763: a responder is not required to include SRV/TXT/address
	// additionals in the PTR response, so issue explicit follow-up queries.
	for instance,e:=range instances{
		if e.srv==nil { if q,qe:=buildMDNSRRQuery(instance+".",33);qe==nil{_ = conn.SetWriteDeadline(time.Now().Add(300*time.Millisecond));_,_=conn.WriteToUDP(q,&net.UDPAddr{IP:net.ParseIP(mdnsIPv4),Port:mdnsPort})} }
	if len(e.txt)==0 { if q,qe:=buildMDNSRRQuery(instance+".",16);qe==nil{_,_=conn.WriteToUDP(q,&net.UDPAddr{IP:net.ParseIP(mdnsIPv4),Port:mdnsPort})} }
	}
	readUntil(time.Now().Add(700*time.Millisecond))
	for _,rr:=range records{e:=instances[strings.ToLower(trimFQDN(rr.name))];if e==nil{continue};switch rr.type_{case 33:if rr.srv!=nil{e.srv=rr.srv};case 16:for k,v:=range rr.txt{e.txt[k]=v}}}
	for _,e:=range instances{if e.srv==nil||e.srv.target==""{continue};qname:=trimFQDN(e.srv.target);for _,qt:=range []uint16{1,28}{q,_:=buildMDNSRRQuery(qname+".",qt);_=conn.SetWriteDeadline(time.Now().Add(300*time.Millisecond));_,_=conn.WriteToUDP(q,&net.UDPAddr{IP:net.ParseIP(mdnsIPv4),Port:mdnsPort})}}
	readUntil(time.Now().Add(600*time.Millisecond))

	for _,e:=range instances{if e.srv==nil||e.srv.target==""||e.srv.port==0{continue};target:=strings.ToLower(trimFQDN(e.srv.target));for _,rr:=range records{if strings.ToLower(trimFQDN(rr.name))==target&&(rr.type_==1||rr.type_==28){e.ips=appendUniqueIPs(e.ips,rr.ips...)}};if len(e.ips)==0{rc,cc:=context.WithTimeout(ctx,500*time.Millisecond);if ip:=resolveMDNSHost(rc,e.srv.target);ip!=nil{e.ips=append(e.ips,ip)};cc()}}

	out:=make([]DeviceInfo,0,len(instances))
	for instance,e:=range instances{if e.srv==nil||len(e.ips)==0{continue};ip:=e.ips[0];scheme:="ipp";if strings.HasPrefix(e.service,"_ipps._tcp")||strings.Contains(e.service,"._ipps._tcp"){scheme="ipps"};rp:=strings.TrimSpace(e.txt["rp"]);if rp==""{rp="/ipp/print"};if !strings.HasPrefix(rp,"/"){rp="/"+rp};host:=strings.TrimSuffix(e.srv.target,".");if host==""{host=ip.String()};name:=strings.SplitN(instance,".",2)[0];if v:=strings.TrimSpace(e.txt["ty"]);v!=""{name=v}else if v:=strings.TrimSpace(e.txt["product"]);v!=""{name=v};caps:=map[string]interface{}{"discovered_via":"mdns_dns_sd","mdns_verified":true,"service_type":e.service,"service_name":instance,"hostname":host,"rp":rp,"port":int(e.srv.port)};for k,v:=range e.txt{caps["txt_"+k]=v};for _,a:=range []struct{src,dst string}{{"ty","model"},{"product","product"},{"adminurl","admin_url"},{"UUID","uuid"}}{if v:=e.txt[a.src];v!=""{caps[a.dst]=v}};out=append(out,DeviceInfo{ID:StableIDFromNetwork(ip.String(),int(e.srv.port)),Name:name,DisplayName:name,PrinterType:"unknown",ConnectionType:"ipp",Protocol:scheme,Endpoint:fmt.Sprintf("%s://%s:%d%s",scheme,host,e.srv.port,rp),NetworkAddress:ip.String(),Port:int(e.srv.port),Status:"online",Enabled:true,Type:"ipp",Capabilities:caps})}
	return out,nil
}

func buildMDNSRRQuery(name string, qtype uint16)([]byte,error){name=strings.TrimSuffix(strings.TrimSpace(name),".")+".";var p []byte;p=append(p,0,0,0,0,0,1,0,0,0,0,0,0);p=append(p,encodeDNSName(name)...);var b [4]byte;binary.BigEndian.PutUint16(b[:2],qtype);binary.BigEndian.PutUint16(b[2:],1);p=append(p,b[:]...);return p,nil}
func appendUniqueIPs(dst []net.IP,ips ...net.IP)[]net.IP{seen:=map[string]bool{};for _,ip:=range dst{seen[ip.String()]=true};for _,ip:=range ips{if ip!=nil&&!seen[ip.String()]{dst=append(dst,ip);seen[ip.String()]=true}};return dst}
