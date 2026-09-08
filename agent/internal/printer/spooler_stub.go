//go:build !windows

package printer

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"
)

type SpoolerPrinter struct {
	Name        string
	SpoolerName string
	PDFPrint    PDFPrintFunc
	ProbeFunc   func(spoolerName string) string
	Timeout     time.Duration
}

func NewSpooler(spoolerName, displayName string) *SpoolerPrinter { name:=spoolerName; if displayName!="" {name=displayName}; return &SpoolerPrinter{Name:name,SpoolerName:spoolerName} }
func (p *SpoolerPrinter) Print(ctx context.Context, data []byte) error {
	if len(data)==0{return fmt.Errorf("refusing to print empty payload")}; if len(data)>maxPrintBytes{return fmt.Errorf("payload %d exceeds %d limit",len(data),maxPrintBytes)}
	select{case <-ctx.Done():return ctx.Err();default:}
	dir:=os.TempDir(); if exeDir,err:=os.Executable();err==nil{dir=filepath.Dir(exeDir)}
	fpath:=filepath.Join(dir,fmt.Sprintf("spooler_%s_%d.prn",sanitizeFilename(p.SpoolerName),time.Now().UnixNano()))
	if err:=os.WriteFile(fpath,data,0644);err!=nil{log.Printf("Spooler stub write failed for %s: %v",p.SpoolerName,err);return fmt.Errorf("spooler stub write failed: %w",err)}
	log.Printf("Spooler stub printed %d bytes for %s to %s",len(data),p.SpoolerName,fpath);return nil
}
func (p *SpoolerPrinter) SupportsKind(kind string) bool { switch NormalizeKind(kind){case KindRaw,KindESCPOS,KindPDF:return true;default:return false} }
func (p *SpoolerPrinter) PrintDocument(ctx context.Context, doc Document) error {
	switch NormalizeKind(doc.Kind){
	case KindPDF:
		if p.PDFPrint!=nil{return PrintPDF(ctx,p.SpoolerName,doc,p.PDFPrint)}; if err:=ValidatePDF(doc.Data);err!=nil{return err}; if err:=ValidatePDFPrinterName(p.SpoolerName);err!=nil{return fmt.Errorf("refusing to print PDF: %w",err)}
		fpath:=filepath.Join(os.TempDir(),fmt.Sprintf("spooler_%s_%d.pdf",sanitizeFilename(p.SpoolerName),time.Now().UnixNano())); if err:=os.WriteFile(fpath,doc.Data,0600);err!=nil{return fmt.Errorf("spooler stub PDF write failed: %w",err)}; log.Printf("Spooler stub SIMULATED a PDF print of %d bytes for %s to %s (no Windows print subsystem on this OS)",len(doc.Data),p.SpoolerName,fpath); return nil
	case KindRaw,KindESCPOS:return p.Print(ctx,doc.Data)
	default:return CapabilityMismatchf("spooler printer %q cannot render %s payloads",p.SpoolerName,NormalizeKind(doc.Kind)) }
}
func (p *SpoolerPrinter) Test(ctx context.Context) error {
	return p.Print(ctx, []byte("\x1b\x40Spooler Test Print from Odoo Agent\nPrinter: "+p.SpoolerName+"\n\n\x1d\x56\x01"))
}

func (p *SpoolerPrinter) Status() string {
	if p.ProbeFunc != nil {
		timeout := p.Timeout
		if timeout <= 0 {
			timeout = 1500 * time.Millisecond
		}
		resCh := make(chan string, 1)
		go func() {
			defer func() {
				if r := recover(); r != nil {
					resCh <- "error"
				}
			}()
			resCh <- p.ProbeFunc(p.SpoolerName)
		}()
		timer := time.NewTimer(timeout)
		defer timer.Stop()
		select {
		case st := <-resCh:
			return st
		case <-timer.C:
			return "spooler_rpc_unresponsive"
		}
	}
	return "online"
}
func sanitizeFilename(s string) string {out:="";for _,r:=range s{if(r>='a'&&r<='z')||(r>='A'&&r<='Z')||(r>='0'&&r<='9')||r=='_'||r=='-'{out+=string(r)}};if out==""{return "printer"};return out}