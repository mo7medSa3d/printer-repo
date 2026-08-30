package printer

import (
	"context"
)

type Printer interface {
	Print(ctx context.Context, data []byte) error
	Test(ctx context.Context) error
	Status() string
}

type DeviceInfo struct {
	ID       string
	Name     string
	Type     string
	Endpoint string
	Protocol string
}
