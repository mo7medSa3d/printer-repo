# Installation

The system has three runtime components: Gateway, Windows Agent/Desktop Manager, and the Odoo integration addon.

## 1. Gateway

```bash
git clone https://github.com/mo7medSa3d/printer-repo.git
cd printer-repo
npm ci
cp .env.example .env
npm run db:migrate
npm run build
npm start
```

Configure PostgreSQL, manager authentication, and the production TLS reverse proxy according to deployment policy.

Verify:

```text
GET /api/health -> {"ok":true}
```

## 2. Windows Agent

Install the Windows Agent/Desktop Manager bundle. Pair the Agent with the Gateway using the pairing flow exposed by the Gateway manager. The Agent owns local printer discovery, heartbeat, queueing and physical execution.

The Gateway manager can inspect runtime agents/printers and their health. Odoo does not create or synchronize these resources.

### PDF Printing in Windows Service (Session 0)

The Windows Agent runs as a background service (`LocalSystem`) without interactive GUI capabilities. To enable silent PDF printing without bundling GPL-licensed binaries:
- **Recommended:** Install SumatraPDF via Windows Package Manager:
  ```powershell
  winget install --id SumatraPDF.SumatraPDF -e --silent
  ```
- **Alternative (Commercial/Permissive CLI):** Place a standalone CLI tool like PDFtoPrinter.exe in `C:\Program Files\OdooPrintAgent\` and configure `pdf_print_command` in config.yaml:
  ```yaml
  pdf_print_command: ["C:\\Program Files\\OdooPrintAgent\\PDFtoPrinter.exe", "{file}", "{printer}"]
  ```

## 3. Gateway API key

In the Gateway manager:

1. Open **API Keys**.
2. Select **Generate API Key**.
3. Copy the raw key immediately.
4. Store it in the Odoo Gateway Configuration screen.
5. Revoke the key from the same Gateway screen when it is no longer trusted.

The raw key is shown only once.

## 4. Odoo addon

Install/upgrade the addon:

```bash
cp -r odoo_addons/print_gateway /path/to/odoo/addons/
odoo-bin -c /etc/odoo.conf -d <db> -i print_gateway --stop-after-init
# later upgrades: -u print_gateway
```

Open **Print Gateway → Gateway Configuration** and enter only:

- Gateway URL
- API Key
- Test Connection
- Gateway Printing Enabled

Then create **Print Bindings**:

`Destination + Document Type -> Printer`

The destination is an existing Odoo object such as POS configuration, warehouse operation type, report action, or company context. The printer is a Gateway runtime printer id.

No Gateway branch identifier, Gateway destination object, Gateway document catalog, Agent record, or Gateway Printer record is configured in Odoo.

## 5. Printing

Use the normal Odoo Print action for supported backend reports.

For POS, use the normal POS receipt/reprint/Print Bill controls. When Gateway printing is enabled, the addon intercepts the Odoo 19 POS print service and queues the operation through the central router without browser printing.

## 6. Upgrade

Gateway: install dependencies, apply the repository migrations, rebuild and restart.
Agent: install the new signed/approved Windows build according to deployment policy.
Odoo: run `-u print_gateway`.

## 7. Release validation

A production release is not complete until CI, Odoo 19 installation/upgrade, Gateway/Agent integration, and physical-printer staging tests are green. The repository does not claim physical E2E from source inspection alone.
