"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button, Modal } from "./ui";

export function JobCleanupButton() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleanup = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/jobs", { method: "DELETE" });
      const data = (await response.json().catch(() => ({}))) as {
        deleted?: number;
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "Failed to clean print jobs");

      setOpen(false);
      window.location.reload();
    } catch (cleanupError) {
      setError(
        cleanupError instanceof Error ? cleanupError.message : "Failed to clean print jobs"
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex flex-col items-end gap-1.5">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
          icon={<Trash2 className="h-4 w-4" />}
        >
          Clean jobs
        </Button>
        {error ? <span role="alert" className="text-xs text-bad">{error}</span> : null}
      </div>

      <Modal
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        title="Clean print jobs?"
        description="This permanently removes terminal job history from the Gateway."
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={cleanup}
              loading={busy}
              icon={<Trash2 className="h-4 w-4" />}
            >
              Clean jobs
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-ink-2">
          <p>Only completed, failed and expired jobs are removed.</p>
          <p>Queued, claimed and printing jobs are never touched.</p>
          <p className="font-medium text-warn">
            This removes Gateway print history and cannot be undone.
          </p>
        </div>
      </Modal>
    </>
  );
}
