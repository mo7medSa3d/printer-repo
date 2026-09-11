package printer

import (
	"encoding/xml"
	"strings"
	"testing"
)

func TestWSDModernProbeUsesNormativeNamespaces(t *testing.T) {
	msg := string(buildWSDSOAPProbe())
	for _, want := range []string{
		`xmlns:wsa="http://www.w3.org/2005/08/addressing"`,
		`xmlns:wsd="http://docs.oasis-open.org/ws-dd/ns/discovery/2009/01"`,
		`<wsa:Action>http://docs.oasis-open.org/ws-dd/ns/discovery/2009/01/Probe</wsa:Action>`,
		`<wsa:To>urn:docs-oasis-open-org:ws-dd:ns:discovery:2009:01</wsa:To>`,
	} {
		if !strings.Contains(msg, want) {
			t.Fatalf("modern WSD probe missing %q", want)
		}
	}
	var env struct {
		Body struct {
			Probe struct{} `xml:"Probe"`
		} `xml:"Body"`
	}
	if err := xml.Unmarshal([]byte(msg), &env); err != nil {
		t.Fatalf("modern WSD probe is not well-formed XML: %v", err)
	}
}

func TestWSDProbeCompatibilityVariantsShareMessageID(t *testing.T) {
	probes := buildWSDSOAPProbes()
	if len(probes) != 2 {
		t.Fatalf("got %d probe variants want 2", len(probes))
	}
	modern := string(probes[0])
	legacy := string(probes[1])
	const marker = `<wsa:MessageID>urn:uuid:`
	mi, li := strings.Index(modern, marker), strings.Index(legacy, marker)
	if mi < 0 || li < 0 {
		t.Fatal("both variants must contain MessageID")
	}
	modernID := modern[mi+len(marker) : mi+len(marker)+36]
	legacyID := legacy[li+len(marker) : li+len(marker)+36]
	if modernID != legacyID {
		t.Fatalf("probe variants must reuse MessageID: %q != %q", modernID, legacyID)
	}
	if !strings.Contains(legacy, `xmlns:wsd="http://schemas.xmlsoap.org/ws/2005/04/discovery"`) {
		t.Fatal("legacy WSD variant missing historical discovery namespace")
	}
}
