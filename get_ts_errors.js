const cp = require('child_process');
try {
  cp.execSync('npx tsc --noEmit', {stdio: 'pipe'});
} catch (e) {
  console.log(e.stdout.toString());
}
