const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// =====================================================================
// 1. quarantineInvalidPdf - defekt: gdy oba sposoby przeniesienia zawiedły,
//    zwracała target zamiast null
// =====================================================================

test('quarantineInvalidPdf: udana kwarantanna zwraca ścieżkę i plik faktycznie tam jest', async (t) => {
  const { quarantineInvalidPdf } = await import('../apps/formularze-ecodan/src/pdfValidation.js');
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-pdf-validation-'));
  t.after(() => fsp.rm(tempDir, { recursive: true, force: true }));

  const sourceFile = path.join(tempDir, 'test.pdf');
  const outputRoot = path.join(tempDir, 'output');

  // Utwórz plik źródłowy
  await fsp.writeFile(sourceFile, 'fake pdf content');

  // Przeniesienie powinno się udać
  const result = await quarantineInvalidPdf(sourceFile, 'Błędny produkt', outputRoot);

  assert.ok(result, 'quarantineInvalidPdf powinno zwrócić ścieżkę przy udanym przeniesieniu');
  assert.ok(result.includes('invalid-pdf'), 'docelowa ścieżka powinna zawierać invalid-pdf');

  // Plik MUSI być w docelowej lokacji
  await fsp.access(result);
  const content = await fsp.readFile(result, 'utf8');
  assert.equal(content, 'fake pdf content');

  // Plik źródłowy powinien być usunięty/przeniesiony
  try {
    await fsp.access(sourceFile);
    assert.fail('plik źródłowy powinien być usunięty');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
});

test('quarantineInvalidPdf: niezistniejący plik zwraca null, nie ścieżkę nieistniejącą', async (t) => {
  const { quarantineInvalidPdf } = await import('../apps/formularze-ecodan/src/pdfValidation.js');
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-pdf-nonexistent-'));
  t.after(() => fsp.rm(tempDir, { recursive: true, force: true }));

  const nonExistentFile = path.join(tempDir, 'nieistniejacy.pdf');
  const outputRoot = path.join(tempDir, 'output');

  // Plik nie istnieje, więc oba sposoby przeniesienia (rename i copyFile+unlink) muszą zawieść
  const result = await quarantineInvalidPdf(nonExistentFile, 'Nie istnieje', outputRoot);

  assert.equal(result, null, 'gdy oba sposoby przeniesienia zawodzą, zwraca null');
});

// =====================================================================
// 2. waitForVarmeroCard - defekt: connect() poza try, nie retry, nie logout
// =====================================================================

test('waitForVarmeroCard: connect() fails on first try, succeeds on second - returns attachment', async (t) => {
  const { waitForVarmeroCard, NoNewEmailError } = await import('../apps/formularze-varmero/src/mailbox.js');

  let connectAttempts = 0;
  const mockClient = {
    connect: async () => {
      connectAttempts++;
      if (connectAttempts === 1) {
        throw new Error('IMAP network error on first try');
      }
      // Second attempt succeeds
    },
    logout: async () => {},
    list: async () => [{ path: 'INBOX' }],
    getMailboxLock: async (folder) => ({
      release: async () => {}
    }),
    search: async ({ to, from }) => {
      // Return a single UID
      return [1];
    },
    download: async (uid, range, opts) => {
      // Return mock email content with card attachment
      return {
        content: Buffer.from(
          'From: noreply@varmero.pl\r\n' +
          'Subject: Test\r\n' +
          'Content-Type: multipart/mixed; boundary=boundary\r\n' +
          '\r\n' +
          '--boundary\r\n' +
          'Content-Type: text/plain\r\n' +
          '\r\n' +
          'Test body\r\n' +
          '--boundary\r\n' +
          'Content-Type: application/pdf; name="Varmero-podsumowanie-123.pdf"\r\n' +
          'Content-Disposition: attachment; filename="Varmero-podsumowanie-123.pdf"\r\n' +
          'Content-Transfer-Encoding: base64\r\n' +
          '\r\n' +
          'JVBERi0xLjQ=\r\n' +
          '--boundary--\r\n'
        )
      };
    }
  };

  const result = await waitForVarmeroCard({
    imapConfig: { user: 'test@example.com', password: 'test' },
    recipientEmail: 'test+varmero@example.com',
    timeoutMs: 1000,
    pollIntervalMs: 50,
    createClient: () => mockClient
  });

  assert.ok(result, 'powinno zwrócić attachment pomimo błędu na pierwszą próbę');
  assert.ok(result.buffer, 'rezultat powinien zawierać buffer');
  assert.match(result.filename, /Varmero-podsumowanie.*\.pdf/i);
  assert.equal(connectAttempts, 2, 'connect powinno być wołane 2 razy');
});

test('waitForVarmeroCard: connect() fails always - timeout with IMAP error in message', async (t) => {
  const { waitForVarmeroCard, NoNewEmailError } = await import('../apps/formularze-varmero/src/mailbox.js');

  let connectAttempts = 0;
  const imaperror = 'IMAP server unavailable';
  const mockClient = {
    connect: async () => {
      connectAttempts++;
      throw new Error(imaperror);
    },
    logout: async () => {}
  };

  try {
    await waitForVarmeroCard({
      imapConfig: { user: 'test@example.com', password: 'test' },
      recipientEmail: 'test+varmero@example.com',
      timeoutMs: 150,
      pollIntervalMs: 50,
      createClient: () => mockClient
    });
    assert.fail('powinno rzucić NoNewEmailError');
  } catch (err) {
    assert.equal(err.name, 'NoNewEmailError');
    assert.match(err.message, /Nie przyszedł mail/);
    assert.match(err.message, /IMAP server unavailable/, 'komunikat błędu powinien zawierać ostatni IMAP error');
    assert.ok(connectAttempts >= 2, `connect powinno być wołane wielokrotnie, było: ${connectAttempts}`);
  }
});

test('waitForVarmeroCard: logout() jest wywoływany nawet gdy connect() rzucił', async (t) => {
  const { waitForVarmeroCard } = await import('../apps/formularze-varmero/src/mailbox.js');

  let logoutCount = 0;
  const mockClient = {
    connect: async () => {
      throw new Error('IMAP error');
    },
    logout: async () => {
      logoutCount++;
    }
  };

  try {
    await waitForVarmeroCard({
      imapConfig: { user: 'test@example.com', password: 'test' },
      recipientEmail: 'test+varmero@example.com',
      timeoutMs: 100,
      pollIntervalMs: 40,
      createClient: () => mockClient
    });
  } catch (err) {
    // Oczekiwany błąd
  }

  assert.ok(logoutCount > 0, `logout powinno być wołane, licznik: ${logoutCount}`);
});

// =====================================================================
// 3. readCaptchaChallenge - defekt: indeks liczony po wszystkich labelach,
//    zamiast po radiach
// =====================================================================

test('readCaptchaChallenge: label bez radia nie przesuwa numeracji pozostalych opcji', async (t) => {
  const { readCaptchaChallenge } = await import('../apps/formularze-varmero/src/automation/captcha.js');

  // readCaptchaChallenge czyta DOM wewnatrz page.evaluate, wiec atrapa musi
  // podstawic minimalny `document` na czas wywolania funkcji przegladarkowej.
  // Scenariusz odwzorowuje naprawiony defekt: SRODKOWY label nie ma radia.
  function makeEl(d) {
    return { getAttribute: (name) => (name === 'd' ? d : null) };
  }
  function makeLabel(hasRadio, d) {
    return {
      querySelector: (sel) => {
        if (sel === 'input[type=radio]') return hasRadio ? { type: 'radio' } : null;
        if (sel === 'path') return makeEl(d);
        return null;
      }
    };
  }
  const labels = [
    makeLabel(true, 'M100 pierwsza-ikona'),
    makeLabel(false, 'M200 label-bez-radia'),
    makeLabel(true, 'M300 trzecia-ikona')
  ];
  const fakeDocument = {
    querySelector: (sel) => (sel === '.cf7ic_instructions'
      ? { textContent: 'Potwierdz wybierając serce.' }
      : null),
    querySelectorAll: (sel) => (sel === '.cf7ic-icon-wrapper label' ? labels : [])
  };
  const page = {
    evaluate: async (fn) => {
      const had = 'document' in globalThis;
      const prev = globalThis.document;
      globalThis.document = fakeDocument;
      try { return await fn(); }
      finally { if (had) globalThis.document = prev; else delete globalThis.document; }
    }
  };

  const result = await readCaptchaChallenge(page);

  assert.ok(result, 'readCaptchaChallenge powinno zwrocic wynik');
  assert.equal(result.word, 'serce');
  assert.equal(result.options.length, 3);
  assert.equal(result.options[0].index, 0, 'pierwszy label z radiem -> index 0');
  assert.equal(result.options[0].hasInput, true);
  assert.equal(result.options[1].index, -1, 'label bez radia -> index -1 (nieklikalny)');
  assert.equal(result.options[1].hasInput, false);
  // Sedno regresji: przed naprawa bylo 2, bo numerowano po WSZYSTKICH labelach.
  assert.equal(result.options[2].index, 1, 'drugi label z radiem -> index 1, nie 2');
  assert.equal(result.options[2].hasInput, true);
});

// =====================================================================
// 4. closeAutomationSession - defekt: close() bez timeoutu mogła zawieszać
// =====================================================================

test('closeAutomationSession (ecodan): close() który nigdy się nie rozwiązuje - funkcja wraca bez zawieszenia', async (t) => {
  const originalEnv = process.env.SCYZORYK_CLOSE_TIMEOUT_MS;
  process.env.SCYZORYK_CLOSE_TIMEOUT_MS = '100'; // 100ms timeout dla testu

  t.after(() => {
    if (originalEnv === undefined) delete process.env.SCYZORYK_CLOSE_TIMEOUT_MS;
    else process.env.SCYZORYK_CLOSE_TIMEOUT_MS = originalEnv;
  });

  const { closeAutomationSession } = await import('../apps/formularze-ecodan/src/automation/session.js');

  // Sesja z close() który nigdy się nie rozwiązuje
  const mockSession = {
    context: {
      close: async () => {
        // Nigdy się nie rozwiązuje
        return new Promise(() => {});
      }
    },
    browser: {
      close: async () => {
        return new Promise(() => {});
      }
    }
  };

  const startTime = Date.now();
  await closeAutomationSession(mockSession);
  const elapsed = Date.now() - startTime;

  // Funkcja powinna wrócić szybko (poniżej ~300ms z buforem)
  assert.ok(elapsed < 500, `closeAutomationSession powinna wrócić poniżej 500ms mimo zawieszenia close(), zajęło ${elapsed}ms`);
});

test('closeAutomationSession (ecodan): close() rzuca błąd - funkcja nie propaguje', async (t) => {
  const originalEnv = process.env.SCYZORYK_CLOSE_TIMEOUT_MS;
  process.env.SCYZORYK_CLOSE_TIMEOUT_MS = '100';

  t.after(() => {
    if (originalEnv === undefined) delete process.env.SCYZORYK_CLOSE_TIMEOUT_MS;
    else process.env.SCYZORYK_CLOSE_TIMEOUT_MS = originalEnv;
  });

  const { closeAutomationSession } = await import('../apps/formularze-ecodan/src/automation/session.js');

  const mockSession = {
    context: {
      close: async () => {
        throw new Error('Context close failed');
      }
    },
    browser: {
      close: async () => {
        throw new Error('Browser close failed');
      }
    }
  };

  // Nie powinno rzucić - błędy są celowo połykane
  await closeAutomationSession(mockSession);
});

test('closeAutomationSession (varmero): close() który nigdy się nie rozwiązuje - funkcja wraca bez zawieszenia', async (t) => {
  const originalEnv = process.env.SCYZORYK_CLOSE_TIMEOUT_MS;
  process.env.SCYZORYK_CLOSE_TIMEOUT_MS = '100';

  t.after(() => {
    if (originalEnv === undefined) delete process.env.SCYZORYK_CLOSE_TIMEOUT_MS;
    else process.env.SCYZORYK_CLOSE_TIMEOUT_MS = originalEnv;
  });

  const { closeAutomationSession } = await import('../apps/formularze-varmero/src/automation/session.js');

  const mockSession = {
    context: {
      close: async () => {
        return new Promise(() => {});
      }
    },
    browser: {
      close: async () => {
        return new Promise(() => {});
      }
    }
  };

  const startTime = Date.now();
  await closeAutomationSession(mockSession);
  const elapsed = Date.now() - startTime;

  assert.ok(elapsed < 500, `varmero closeAutomationSession powinna wrócić poniżej 500ms mimo zawieszenia close(), zajęło ${elapsed}ms`);
});

test('closeAutomationSession (varmero): close() rzuca błąd - funkcja nie propaguje', async (t) => {
  const originalEnv = process.env.SCYZORYK_CLOSE_TIMEOUT_MS;
  process.env.SCYZORYK_CLOSE_TIMEOUT_MS = '100';

  t.after(() => {
    if (originalEnv === undefined) delete process.env.SCYZORYK_CLOSE_TIMEOUT_MS;
    else process.env.SCYZORYK_CLOSE_TIMEOUT_MS = originalEnv;
  });

  const { closeAutomationSession } = await import('../apps/formularze-varmero/src/automation/session.js');

  const mockSession = {
    context: {
      close: async () => {
        throw new Error('Context close failed');
      }
    },
    browser: {
      close: async () => {
        throw new Error('Browser close failed');
      }
    }
  };

  await closeAutomationSession(mockSession);
});
