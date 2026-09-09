package printer

import "testing"

func TestSanitizeTestTextStripsCommandBytes(t *testing.T) {
	if got := sanitizeTestText("ACME\x1b@Corp\x00Ltd\x7f!"); got != "ACME@CorpLtd!" {
		t.Fatalf("sanitizeTestText = %q, want printable-only text", got)
	}
	if got := sanitizeTestText("A^B~C\"D"); got != "A^B~C\"D" {
		t.Fatalf("sanitizeTestText must not alter visible punctuation, got %q", got)
	}
}
