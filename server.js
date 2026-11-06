require('./config/load-env').loadEnvironment();

const { createDaybreakApp } = require('./lib/create-app');

const { app } = createDaybreakApp({ env: process.env, projectRoot: __dirname });

const port = process.env.PORT || 3000;
// Ohne ausdrückliche Einstellung nur von diesem Rechner erreichbar.
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => console.log(`Daybreak läuft auf http://${host}:${port}`));
