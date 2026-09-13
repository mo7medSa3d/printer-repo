import type { ManagerClaims, ManagerRole } from "./manager-auth";

export type ManagerPermission =
  | "tenant.read" | "tenant.update"
  | "users.read" | "users.manage"
  | "agents.read" | "agents.pair" | "agents.disable" | "agents.retire"
  | "printers.read" | "printers.manage" | "printers.test"
  | "jobs.read" | "jobs.create" | "jobs.retry" | "jobs.cancel"
  | "bindings.read" | "bindings.manage"
  | "integrations.read" | "integrations.manage"
  | "billing.read" | "billing.manage";

const permissionsByRole: Record<ManagerRole, ReadonlySet<ManagerPermission>> = {
  owner: new Set<ManagerPermission>([
    "tenant.read", "tenant.update", "users.read", "users.manage",
    "agents.read", "agents.pair", "agents.disable", "agents.retire",
    "printers.read", "printers.manage", "printers.test",
    "jobs.read", "jobs.create", "jobs.retry", "jobs.cancel", "bindings.read", "bindings.manage",
    "integrations.read", "integrations.manage", "billing.read", "billing.manage",
  ]),
  admin: new Set<ManagerPermission>([
    "tenant.read", "users.read", "users.manage",
    "agents.read", "agents.pair", "agents.disable", "agents.retire",
    "printers.read", "printers.manage", "printers.test",
    "jobs.read", "jobs.create", "jobs.retry", "jobs.cancel", "bindings.read", "bindings.manage",
    "integrations.read", "integrations.manage", "billing.read", "billing.manage",
  ]),
  operator: new Set<ManagerPermission>([
    "tenant.read", "agents.read", "printers.read", "printers.test",
    "jobs.read", "jobs.create", "jobs.retry", "jobs.cancel", "bindings.read",
  ]),
  viewer: new Set<ManagerPermission>([
    "tenant.read", "agents.read", "printers.read", "jobs.read", "bindings.read",
  ]),
  integration_admin: new Set<ManagerPermission>([
    "tenant.read", "agents.read", "printers.read", "jobs.read",
    "bindings.read", "bindings.manage", "integrations.read", "integrations.manage",
  ]),
  billing_admin: new Set<ManagerPermission>([
    "tenant.read", "billing.read", "billing.manage",
  ]),
};

export function hasManagerPermission(claims: ManagerClaims, permission: ManagerPermission): boolean {
  return permissionsByRole[claims.role]?.has(permission) ?? false;
}

export function requireManagerPermission(claims: ManagerClaims, permission: ManagerPermission): void {
  if (!hasManagerPermission(claims, permission)) {
    const error = new Error(`Missing permission: ${permission}`);
    Object.assign(error, { code: "FORBIDDEN", status: 403 });
    throw error;
  }
}
