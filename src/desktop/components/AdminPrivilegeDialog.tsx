import React, { useState } from "react";
import { AlertTriangle, ShieldAlert } from "lucide-react";
import { Button, Modal } from "../../components/ui";
import { closeApp } from "../lib/ipc";

export interface AdminPrivilegeDialogProps {
  open: boolean;
  onClose: () => void;
  onRelaunch?: () => void;
}

export function AdminPrivilegeDialog({
  open,
  onClose,
  onRelaunch,
}: AdminPrivilegeDialogProps) {
  const [closing, setClosing] = useState(false);

  const handleCloseAndReopen = async () => {
    setClosing(true);
    try {
      if (onRelaunch) {
        onRelaunch();
      } else {
        await closeApp();
      }
    } catch {
      // Best-effort window close
      if (typeof window !== "undefined") {
        window.close();
      }
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Administrator privileges required"
      description="Elevated permissions needed to control the Windows print service"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={onClose}
            disabled={closing}
          >
            Continue in Read-Only Mode
          </Button>
          <Button
            variant="primary"
            onClick={handleCloseAndReopen}
            loading={closing}
            icon={<ShieldAlert className="h-4 w-4" aria-hidden="true" />}
          >
            Close &amp; Reopen as Administrator
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-[14px] leading-relaxed text-ink-2">
        <div
          className="flex items-start gap-3 rounded-lg border border-warn-edge bg-warn-bg p-3.5 text-warn"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <div className="text-[13px] leading-normal text-ink">
            <strong className="font-semibold text-warn">Service Management Restricted:</strong>{" "}
            Windows requires elevated Administrator privileges to install, configure, start, and stop the background print agent service.
          </div>
        </div>

        <p className="text-ink">
          Desktop Agent Manager must be running as Administrator to manage the Agent service. Close this window and reopen Desktop Agent Manager as Administrator.
        </p>

        <div className="rounded-lg border border-edge bg-surface-2 p-3.5 text-[13px] text-ink-3">
          <div className="font-medium text-ink mb-1.5">How to relaunch as Administrator:</div>
          <ol className="list-decimal pl-5 space-y-1">
            <li>Close this application window.</li>
            <li>Right-click the <strong>Odoo Print Manager</strong> application shortcut or executable.</li>
            <li>Select <strong>Run as administrator</strong> from the Windows context menu.</li>
          </ol>
        </div>
      </div>
    </Modal>
  );
}
