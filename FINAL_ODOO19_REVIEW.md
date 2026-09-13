# Final Odoo 19 Review

## Findings

- Report interception is implemented around Odoo report action behavior rather than only around PDF generation.
- `/report/download` is explicitly considered for Gateway routing.
- POS sale-details behavior was reviewed so Gateway-enabled mode does not silently return to native printing on a browser PDF Accept header.
- Odoo remains the business source of truth; Gateway stores runtime/print control-plane state.

Odoo 19 documentation confirms `ir.actions.report` is the report action mechanism and documents QWeb PDF reports, report bindings, access groups, and the report engine. citeturn639871search0

## Security observation

Odoo `sudo()` bypasses record rules/access rights, so every such path must be proven with company/tenant scoping in live Odoo tests. The code contains explicit checks in key paths, but runtime proof was unavailable. Odoo 19 security documentation makes this bypass behavior explicit. citeturn639871search0turn639871search2

## Required live regression matrix

- Sales Order
- Invoice
- Delivery / Inventory
- Purchase
- Custom report
- POS Full Receipt
- POS Simplified Receipt
- POS Reprint
- Restaurant Bill
- Automatic Receipt Printing
- POS sale-details
- Kitchen / Preparation printing
- Gateway disabled/native mode
- Gateway enabled mode
- Gateway unavailable
- Missing binding
- Wrong printer

## Kitchen / preparation status

The architecture deliberately avoids pretending this path is fully Gateway-routed unless a complete payload/binding contract exists. This must remain explicit and fail-closed until a live Odoo 19 runtime proves the complete path.

## Verdict
`CODE REVIEWED — ODOO 19 RUNTIME / BROWSER NOT VERIFIED`
