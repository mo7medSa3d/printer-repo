const fs = require('fs');
let content = fs.readFileSync('odoo_addons/print_gateway/tests/test_control_plane.py', 'utf8');

content = content.replace(
  /wenv\[\"print_gateway\.binding\"\]\.create\(\{/,
  'wenv["print_gateway.binding"].create({\n                "branch_id": self.branch.id,'
);
fs.writeFileSync('odoo_addons/print_gateway/tests/test_control_plane.py', content);
