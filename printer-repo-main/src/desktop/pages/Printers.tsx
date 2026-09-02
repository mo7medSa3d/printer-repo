import React from "react";
import { Eye, Plus, Printer as PrinterIcon, RefreshCw, Search, Zap } from "lucide-react";
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Mono,
  Select,
  StatusBadge,
  StatusDot,
} from "@/components/ui";
import { Toolbar } from "../ui";
import { PrinterAvatar } from "../ui";
import type { DesktopState } from "../types";
import {
  humanConnection,
  humanType,
  isProductionPrinter,
  labelPrinter,
  printerEndpoint,
  printerTone,
} from "../lib/printers";

export function PrintersPage({ s }: { s: DesktopState }) {
  const rows = s.filteredPrinters.filter(isProductionPrinter);
  const total = s.printers.filter(isProductionPrinter).length;

  return (
    <div className="space-y-7">
      <Toolbar>
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-ink-3"
            aria-hidden
          />
          <Input
            value={s.printersFilter}
            onChange={(e) => s.setPrintersFilter(e.target.value)}
            placeholder="Search by name, type or address…"
            className="pl-11"
            aria-label="Search printers"
          />
        </div>
        <Select
          value={s.statusFilter}
          onChange={(e) => s.setStatusFilter(e.target.value as typeof s.statusFilter)}
          className="lg:w-48"
          aria-label="Filter by status"
        >
          <option value="all">All statuses</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
        </Select>
        <div className="flex flex-wrap gap-3">
          <Button
            variant="primary"
            onClick={() => s.setShowAdd(true)}
            icon={<Plus className="h-[18px] w-[18px]" />}
          >
            Add printer
          </Button>
          <Button
            variant="secondary"
            onClick={s.handleDiscover}
            loading={s.printersLoading}
            icon={<RefreshCw className="h-[18px] w-[18px]" />}
          >
            Discover
          </Button>
          <Button
            variant="ghost"
            onClick={s.refreshPrinters}
            icon={<RefreshCw className="h-[18px] w-[18px]" />}
          >
            Refresh
          </Button>
        </div>
      </Toolbar>

      {s.printersError && !s.printersLoading && (
        <ErrorState
          title="Could not load printers"
          message={s.printersError}
          retry={s.refreshPrinters}
        />
      )}

      <Card className="overflow-hidden">
        <CardHeader
          title={
            <span className="flex items-center gap-3">
              Printers
              <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[12px] font-semibold tabular-nums text-ink-3">
                {total} total
              </span>
            </span>
          }
          subtitle="Physical print devices this agent can reach"
          icon={<PrinterIcon className="h-5 w-5 flex-shrink-0 text-brand" aria-hidden />}
        />
        {s.printersLoading ? (
          <div className="p-6">
            <LoadingState rows={5} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<PrinterIcon className="h-10 w-10" />}
            title={total === 0 ? "No printers connected" : "No matches"}
            description={
              total === 0
                ? "Connect a physical printer to this PC, then run Discovery or add it manually. Virtual, software and redirected printers are never listed here."
                : "Try a different search term or status filter."
            }
            action={
              total === 0 ? (
                <>
                  <Button
                    variant="primary"
                    onClick={s.handleDiscover}
                    icon={<RefreshCw className="h-4 w-4" />}
                  >
                    Discover printers
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => s.setShowAdd(true)}
                    icon={<Plus className="h-4 w-4" />}
                  >
                    Add printer
                  </Button>
                </>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y border-edge table-head text-left">
                  <th className="px-6 py-3">Printer</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Connection</th>
                  <th className="px-4 py-3">Endpoint</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-6 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr
                    key={p.id}
                    className="border-b border-edge last:border-0 row-hover"
                  >
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3.5">
                        <PrinterAvatar
                          name={p.name}
                          size="lg"
                          tone={
                            printerTone(p.status) === "neutral"
                              ? "brand"
                              : printerTone(p.status)
                          }
                        />
                        <div className="min-w-0">
                          <div className="truncate text-[15px] font-semibold text-ink">
                            {p.name}
                          </div>
                          <div className="truncate text-[12px] text-ink-4">
                            <Mono>{p.id}</Mono>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-4 text-[14px] text-ink-2">
                      {humanType(p)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-4 text-[14px] text-ink-2">
                      {humanConnection(p)}
                    </td>
                    <td className="px-4 py-4 text-[13px] text-ink-3">
                      <Mono>{printerEndpoint(p)}</Mono>
                    </td>
                    <td className="px-4 py-4">
                      <StatusBadge
                        tone={printerTone(p.status)}
                        label={labelPrinter(p.status)}
                      />
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => s.handleTest(p.id)}
                          icon={<Zap className="h-4 w-4" />}
                        >
                          Test
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => s.setSelectedPrinter(p)}
                          icon={<Eye className="h-4 w-4" />}
                        >
                          Details
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!s.printersLoading && rows.length > 0 && (
          <div className="flex items-center gap-6 border-t border-edge px-6 py-4 text-[13px] text-ink-3">
            <span className="inline-flex items-center gap-2">
              <StatusDot tone="ok" /> {s.onlinePrinters} online
            </span>
            <span className="inline-flex items-center gap-2">
              <StatusDot tone="bad" /> {s.offlinePrinters} need attention
            </span>
          </div>
        )}
      </Card>
    </div>
  );
}
