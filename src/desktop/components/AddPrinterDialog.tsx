/* eslint-disable react-hooks/set-state-in-effect */
import React, { useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import {
  Button,
  Modal,
  Field,
  Input,
  Select,
  ErrorState,
} from "../../components/ui";
import { registerPrinter, type PrinterInfo } from "../lib/ipc";
import { errMsg, friendlyPrinterError, isProductionPrinter } from "../lib/printers";

type Conn = "spooler" | "network" | "usb" | "ipp";

export function AddPrinterDialog({
  open,
  onClose,
  onSuccess,
  printers,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  printers: PrinterInfo[];
}) {
  const [name, setName] = useState("");
  const [conn, setConn] = useState<Conn>("spooler");
  const [spoolerName, setSpoolerName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("9100");
  const [protocol, setProtocol] = useState("raw");
  const [ippUrl, setIppUrl] = useState("");
  const [usbSel, setUsbSel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Only physical printers may be picked for a production binding.
  const physicalSpoolers = useMemo(
    () => printers.filter((p) => isProductionPrinter(p) && p.spooler_name),
    [printers]
  );
  const usbPrinters = useMemo(
    () =>
      printers.filter(
        (p) => (p.connection_type || "").toLowerCase() === "usb" && isProductionPrinter(p)
      ),
    [printers]
  );

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const validate = (): string | null => {
    if (!name.trim()) return "Printer name is required.";
    if (conn === "spooler" && !spoolerName.trim())
      return "Select or type a spooler printer name.";
    if (conn === "network") {
      if (!host.trim()) return "Host is required.";
      if (host.includes(" ")) return "Invalid host.";
      const p = parseInt(port, 10);
      if (isNaN(p) || p < 1 || p > 65535) return "Port must be 1–65535.";
    }
    if (conn === "ipp" && !ippUrl.trim()) return "IPP endpoint is required.";
    if (
      conn === "ipp" &&
      ippUrl.trim() &&
      !/^https?:\/\//i.test(ippUrl) &&
      !/^ipp:\/\//i.test(ippUrl)
    )
      return "IPP URL must start with http://, https:// or ipp://";
    if (conn === "usb" && !usbSel) return "Select a USB printer.";
    return null;
  };

  const reset = () => {
    setName("");
    setHost("");
    setPort("9100");
    setSpoolerName("");
    setIppUrl("");
    setUsbSel("");
  };

  const handleSubmit = async () => {
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const req: Record<string, unknown> = { name: name.trim(), connectionType: conn };
      if (conn === "spooler") {
        req.spoolerName = spoolerName.trim();
        req.endpoint = spoolerName.trim();
        req.protocol = "spooler";
      }
      if (conn === "network") {
        req.endpoint = `${host.trim()}:${port.trim()}`;
        req.protocol = protocol;
      }
      if (conn === "ipp") {
        req.endpoint = ippUrl.trim();
        req.protocol = "ipp";
      }
      if (conn === "usb") {
        const sel = usbPrinters.find((p) => p.id === usbSel);
        if (sel) {
          req.usbVid = sel.usbVid;
          req.usbPid = sel.usbPid;
          req.usbSerial = sel.usbSerial;
          req.spoolerName = sel.spooler_name || sel.name;
          if (req.spoolerName) req.endpoint = req.spoolerName;
        }
      }
      await registerPrinter(req as never);
      onSuccess();
      onClose();
      reset();
    } catch (e) {
      setError(friendlyPrinterError(errMsg(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add printer"
      description="Register a printer for this agent. Discovery is preferred, but manual registration works for legacy devices."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={busy}
            icon={<Plus className="h-4 w-4" />}
          >
            Add printer
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Printer name" htmlFor="pp-name">
          <Input
            id="pp-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Kitchen receipt"
            autoFocus
          />
        </Field>
        <Field label="Connection type" htmlFor="pp-conn">
          <Select
            id="pp-conn"
            value={conn}
            onChange={(e) => setConn(e.target.value as Conn)}
          >
            <option value="spooler">Windows spooler</option>
            <option value="network">Network (TCP)</option>
            <option value="usb">USB</option>
            <option value="ipp">IPP</option>
          </Select>
        </Field>
        {conn === "spooler" && (
          <Field
            label="Spooler printer"
            htmlFor="pp-spooler"
            hint={
              physicalSpoolers.length === 0
                ? "No physical spooler printers were discovered — run Discovery first, or type the exact Windows printer name. Virtual and redirected printers are never listed."
                : "Only physical printers discovered on this PC are listed."
            }
          >
            <Select
              id="pp-spooler"
              value={spoolerName}
              onChange={(e) => setSpoolerName(e.target.value)}
            >
              <option value="">Select…</option>
              {physicalSpoolers.map((p) => (
                <option key={p.id} value={p.spooler_name || p.name}>
                  {p.name}
                </option>
              ))}
              {physicalSpoolers.length === 0 && <option disabled>None discovered</option>}
            </Select>
            {physicalSpoolers.length === 0 && (
              <Input
                className="mt-3"
                value={spoolerName}
                onChange={(e) => setSpoolerName(e.target.value)}
                placeholder="Type Windows printer name"
              />
            )}
          </Field>
        )}
        {conn === "network" && (
          <div className="grid grid-cols-[1.6fr_1fr] gap-4">
            <Field label="Host" htmlFor="pp-host">
              <Input
                id="pp-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.50"
              />
            </Field>
            <Field label="Port" htmlFor="pp-port">
              <Input
                id="pp-port"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="9100"
                inputMode="numeric"
              />
            </Field>
            <Field
              label="Protocol"
              htmlFor="pp-proto"
              className="col-span-2"
              hint="RAW sends bytes as-is; ESC/POS is the usual thermal receipt language."
            >
              <Select
                id="pp-proto"
                value={protocol}
                onChange={(e) => setProtocol(e.target.value)}
              >
                <option value="raw">RAW</option>
                <option value="escpos">ESC/POS</option>
              </Select>
            </Field>
          </div>
        )}
        {conn === "usb" && (
          <Field
            label="USB printer"
            htmlFor="pp-usb"
            hint="Only valid USB printers are listed — generic USB devices are hidden."
          >
            <Select id="pp-usb" value={usbSel} onChange={(e) => setUsbSel(e.target.value)}>
              <option value="">Select…</option>
              {usbPrinters.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} {p.usbVid ? `(${p.usbVid}:${p.usbPid})` : ""}
                </option>
              ))}
              {usbPrinters.length === 0 && <option disabled>No USB printers discovered</option>}
            </Select>
          </Field>
        )}
        {conn === "ipp" && (
          <Field
            label="IPP endpoint"
            htmlFor="pp-ipp"
            hint="Examples: ipp://192.168.1.60/ipp/print or http://host:631/ipp/print"
          >
            <Input
              id="pp-ipp"
              value={ippUrl}
              onChange={(e) => setIppUrl(e.target.value)}
              placeholder="ipp://192.168.1.60/ipp/print"
            />
          </Field>
        )}
        {error && <ErrorState title="Cannot add printer" message={error} />}
      </div>
    </Modal>
  );
}
