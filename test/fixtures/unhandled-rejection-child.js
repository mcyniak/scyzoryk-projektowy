const { setupProcessDiagnostics } = require('../../lib/hardening');

setupProcessDiagnostics('unhandled-rejection-test', process.argv[2]);
Promise.reject(new Error('testowe odrzucenie'));

// Proces powinien zakonczyc sie przez handler diagnostyczny, zanim ten timer zadziala.
// 30s, nie 2s: process.report.writeReport() jest synchroniczny i na wolnym/skanowanym
// przez AV dysku CI (zaobserwowane na windows-latest w GitHub Actions) potrafi trwac
// kilka-kilkanascie sekund - zbyt ciasny fallback tutaj wygrywal wyscig z prawdziwym
// exit(1) z lib/hardening.js i test fałszywie widzial kod 0.
setTimeout(() => process.exit(0), 30000);
