const fs = require('fs');
let file = fs.readFileSync('src/app/api/auth/manager/login/route.ts', 'utf8');

file = file.replace(
    'return NextResponse.json({ error: "Manager tenant is not configured for this hostname" }, { status: 503 });',
    'return NextResponse.json({ error: "Manager tenant is not configured for this hostname" }, { status: 401 });'
);

fs.writeFileSync('src/app/api/auth/manager/login/route.ts', file);
