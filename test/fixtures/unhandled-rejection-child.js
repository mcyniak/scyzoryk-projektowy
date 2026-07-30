const { setupProcessDiagnostics } = require('../../lib/hardening');

setupProcessDiagnostics('unhandled-rejection-test', process.argv[2]);
Promise.reject(new Error('testowe odrzucenie'));

// Proces powinien zakonczyc sie przez handler diagnostyczny, zanim ten timer zadziala.
setTimeout(() => process.exit(0), 2000);
