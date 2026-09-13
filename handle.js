const next = require('next');
const app = next({dev: true, hostname: 'localhost', port: 3000});
app.prepare().then(() => {
  const handle = app.getRequestHandler();
  // What is the arity of handle?
  console.log(handle.length);
});
