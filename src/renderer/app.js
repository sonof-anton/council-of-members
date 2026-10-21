'use strict';

(function () {
  // ========== VIEW SWITCHER ==========
  const LEVELS = ['level-0', 'level-1', 'level-2', 'level-3'];

  function switchLevel(level) {
    var buttons = document.querySelectorAll('#view-switcher button');
    buttons.forEach(function (btn) {
      btn.classList.toggle('active', parseInt(btn.dataset.level, 10) === level);
    });
    LEVELS.forEach(function (id, i) {
      var el = document.getElementById(id);
      if (i === level) {
        el.classList.add('level-active');
      } else {
        el.classList.remove('level-active');
      }
    });
    window.council.setLevel(level);
  }

  // ========== FILE ATTACHMENTS ==========
  var attachedFiles = [];

  function initFileDrop() {
    var dropZone = document.getElementById('file-drop-zone');
    var fileInput = document.getElementById('file-input');
    var promptInput = document.getElementById('prompt-input');

    // Click to open file picker
    dropZone.addEventListener('click', function () {
      fileInput.click();
    });

    fileInput.addEventListener('change', function () {
      handleFiles(fileInput.files);
      fileInput.value = '';
    });

    // Drag over prompt area or drop zone
    [dropZone, promptInput].forEach(function (el) {
      el.addEventListener('dragover', function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add('drag-over');
      });

      el.addEventListener('dragleave', function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('drag-over');
      });

      el.addEventListener('drop', function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('drag-over');
        if (e.dataTransfer.files.length > 0) {
          handleFiles(e.dataTransfer.files);
        }
      });
    });
  }

  function handleFiles(fileList) {
    for (var i = 0; i < fileList.length; i++) {
      var file = fileList[i];
      readFile(file);
    }
  }

  function readFile(file) {
    // Read as text for text files, as data URL for others
    var reader = new FileReader();
    var isText = file.type.startsWith('text/') ||
      /\.(js|ts|py|json|xml|html|css|md|txt|csv|yaml|yml|toml|cfg|ini|log|sh|bat|ps1|rb|go|rs|java|c|cpp|h|hpp|sql)$/i.test(file.name);

    if (isText) {
      reader.onload = function (e) {
        attachedFiles.push({ name: file.name, content: e.target.result, type: 'text' });
        renderFileList();
      };
      reader.readAsText(file);
    } else {
      // For binary files, store the path info so it can be dropped into browser views
      reader.onload = function (e) {
        attachedFiles.push({ name: file.name, content: e.target.result, type: 'binary', size: file.size });
        renderFileList();
      };
      reader.readAsDataURL(file);
    }
  }

  function renderFileList() {
    var listEl = document.getElementById('file-list');
    listEl.innerHTML = '';
    attachedFiles.forEach(function (f, idx) {
      var entry = document.createElement('div');
      entry.className = 'file-entry';

      var nameSpan = document.createElement('span');
      nameSpan.className = 'file-name';
      nameSpan.textContent = f.name;

      var typeSpan = document.createElement('span');
      typeSpan.className = 'file-type';
      typeSpan.textContent = f.type === 'text' ? '[TXT]' : '[BIN]';

      var removeBtn = document.createElement('button');
      removeBtn.className = 'file-remove';
      removeBtn.textContent = 'X';
      removeBtn.addEventListener('click', function () {
        attachedFiles.splice(idx, 1);
        renderFileList();
      });

      entry.appendChild(typeSpan);
      entry.appendChild(nameSpan);
      entry.appendChild(removeBtn);
      listEl.appendChild(entry);
    });
  }

  function buildPromptWithFiles(prompt) {
    if (attachedFiles.length === 0) return prompt;

    var parts = [prompt, '', '--- ATTACHED FILES ---'];
    attachedFiles.forEach(function (f) {
      if (f.type === 'text') {
        parts.push('');
        parts.push('=== FILE: ' + f.name + ' ===');
        parts.push(f.content);
        parts.push('=== END FILE ===');
      } else {
        parts.push('');
        parts.push('[Binary file attached: ' + f.name + ' (' + f.size + ' bytes)]');
      }
    });
    return parts.join('\n');
  }

  // ========== LOGIN STATE ==========
  var loginState = { claude: false, grok: false, gemini: false };
  var autoSwitchedFromLogin = false;

  // ========== CHANCELLOR INPUT ==========
  var busy = false;
  var currentRound = 0;
  var memberTimers = {};
  var memberWaiting = {}; // track which members are in "wait" mode

  function handleSend() {
    var inputEl = document.getElementById('prompt-input');
    var prompt = inputEl.value.trim();
    if (!prompt || busy) return;

    var fullPrompt = buildPromptWithFiles(prompt);

    busy = true;
    currentRound = 0;
    memberWaiting = {};
    document.getElementById('btn-send').style.display = 'none';
    document.getElementById('btn-abort').style.display = 'inline-block';
    inputEl.disabled = true;
    showStatus('.TX TRANSMITTING TO MEMBERS...', 'waiting');

    // Clear previous session's response history
    renderedResponses = {};
    var histories = document.querySelectorAll('.ai-response-history');
    histories.forEach(function (h) { h.innerHTML = ''; });
    // Hide previous consensus
    document.getElementById('consensus-area').classList.remove('visible');
    document.getElementById('level-1').classList.remove('has-consensus');

    window.council.sendPrompt(fullPrompt).then(function (result) {
      if (!result.success) {
        showStatus('NACK: ' + result.reason, 'error');
      }
      busy = false;
      document.getElementById('btn-send').style.display = 'inline-block';
      document.getElementById('btn-abort').style.display = 'none';
      inputEl.disabled = false;
    });
  }

  function handleAbort() {
    showStatus('.ABORT SIGNAL SENT', 'error');
    window.council.abort();
  }

  function showStatus(text, type) {
    var el = document.getElementById('chancellor-status');
    el.textContent = text;
    el.className = '';
    if (type === 'waiting') el.classList.add('status-waiting');
    else if (type === 'error') el.classList.add('status-error');
    else if (type === 'responded') el.classList.add('status-responded');
    else el.classList.add('status-info');
  }

  var phaseLabels = {
    IDLE: '',
    TRANSMITTING: '.TX IN PROGRESS',
    WAITING: 'WAITING FOR .RX',
    COLLECTING: 'COLLECTING .RX',
    COMBINING: 'COMBINING RESPONSES',
    UNIFYING: 'MEMBERS AGREE — UNIFYING ANSWER...',
    CONSENSUS: '.RX CONSENSUS ACK',
    TIMEOUT: 'TIMEOUT - NO CONSENSUS',
    ABORTED: 'SESSION ABORTED'
  };

  var phaseStatusType = {
    IDLE: 'info',
    TRANSMITTING: 'waiting',
    WAITING: 'waiting',
    COLLECTING: 'waiting',
    COMBINING: 'waiting',
    UNIFYING: 'waiting',
    CONSENSUS: 'responded',
    TIMEOUT: 'error',
    ABORTED: 'error'
  };

  // ========== CONSENSUS DISPLAY ==========
  function showConsensus(answer, rounds, noConsensus) {
    var area = document.getElementById('consensus-area');
    var header = document.getElementById('consensus-header');
    var body = document.getElementById('consensus-body');
    var meta = document.getElementById('consensus-meta');

    if (noConsensus) {
      header.textContent = '.RX NO CONSENSUS — INDIVIDUAL ANSWERS';
      header.style.color = 'var(--yellow)';
    } else {
      header.textContent = '.RX CONSENSUS';
      header.style.color = '';
    }

    body.textContent = answer;
    meta.textContent = 'ROUNDS: ' + rounds + ' | TIMESTAMP: ' + new Date().toISOString();
    area.classList.add('visible');
    document.getElementById('level-1').classList.add('has-consensus');
  }

  function showConsensusWithMembers(answers, rounds, noConsensus) {
    var area = document.getElementById('consensus-area');
    var header = document.getElementById('consensus-header');
    var bodyEl = document.getElementById('consensus-body');
    var meta = document.getElementById('consensus-meta');

    if (noConsensus) {
      header.textContent = '.RX NO CONSENSUS — INDIVIDUAL ANSWERS';
      header.style.color = 'var(--yellow)';
    } else {
      header.textContent = '.RX CONSENSUS — ALL MEMBER ANSWERS';
      header.style.color = '';
    }

    // Build formatted body with each member's answer
    bodyEl.innerHTML = '';
    var names = Object.keys(answers);
    for (var i = 0; i < names.length; i++) {
      var name = names[i];

      var memberHeader = document.createElement('div');
      memberHeader.style.color = 'var(--blue)';
      memberHeader.style.fontSize = '12px';
      memberHeader.style.letterSpacing = '2px';
      memberHeader.style.marginTop = i > 0 ? '16px' : '0';
      memberHeader.style.marginBottom = '8px';
      memberHeader.style.borderBottom = '1px solid var(--dim-green)';
      memberHeader.style.paddingBottom = '4px';
      memberHeader.textContent = '=== ' + name.toUpperCase() + ' ===';

      var memberBody = document.createElement('div');
      memberBody.style.whiteSpace = 'pre-wrap';
      memberBody.style.wordWrap = 'break-word';
      memberBody.textContent = answers[name];

      bodyEl.appendChild(memberHeader);
      bodyEl.appendChild(memberBody);
    }

    meta.textContent = 'ROUNDS: ' + rounds + ' | MEMBERS: ' + names.length + ' | TIMESTAMP: ' + new Date().toISOString();
    area.classList.add('visible');
    document.getElementById('level-1').classList.add('has-consensus');
  }

  // ========== STATUS PANEL ==========
  function setRound(round) {
    currentRound = round;
    var text = 'ROUND ' + String(round).padStart(2, '0');
    var el = document.getElementById('status-round');
    el.textContent = text;
    var l3 = document.getElementById('l3-round');
    if (l3) l3.textContent = text;
  }

  function setPhase(phase) {
    var el = document.getElementById('status-phase');
    el.textContent = phase;
    var cls = {
      IDLE: 'status-info', TRANSMITTING: 'status-waiting', WAITING: 'status-waiting',
      COLLECTING: 'status-waiting', COMBINING: 'status-waiting',
      CONSENSUS: 'status-responded', TIMEOUT: 'status-error', ABORTED: 'status-error'
    };
    el.className = '';
    el.classList.add(cls[phase] || 'status-info');

    var l3 = document.getElementById('l3-phase');
    if (l3) {
      l3.textContent = phase;
      l3.className = '';
      l3.classList.add(cls[phase] || 'status-info');
    }
  }

  function setAiStatus(name, status, vote) {
    var col = document.querySelector('.ai-column[data-ai="' + name + '"]');
    if (!col) return;

    var statusEl = col.querySelector('.ai-status');
    var voteEl = col.querySelector('.ai-vote');

    var statusLabels = { STANDBY: 'STANDBY', TRANSMITTING: '.TX TYPING...', WAITING: 'WAITING .RX', RESPONDED: '.RX RECEIVED', ERROR: 'ERROR', SKIPPED: 'SKIPPED' };
    var statusClasses = { STANDBY: 'status-info', TRANSMITTING: 'status-waiting', WAITING: 'status-waiting', RESPONDED: 'status-responded', ERROR: 'status-error', SKIPPED: 'status-error' };

    statusEl.textContent = statusLabels[status] || status;
    statusEl.className = 'ai-status';
    statusEl.classList.add(statusClasses[status] || 'status-info');

    if (vote === 'YES') {
      voteEl.textContent = 'YAY';
      voteEl.className = 'ai-vote vote-yes';
    } else if (vote === 'NO') {
      voteEl.textContent = 'NAY';
      voteEl.className = 'ai-vote vote-no';
    } else {
      voteEl.textContent = '--';
      voteEl.className = 'ai-vote vote-pending';
    }

    // Timer/skip/wait visibility
    var timerEl = col.querySelector('.ai-timer');
    var skipBtn = col.querySelector('.btn-skip');
    var waitBtn = col.querySelector('.btn-wait');
    if (status === 'WAITING') {
      if (timerEl) timerEl.style.display = '';
      memberTimers[name] = Date.now();
    } else {
      if (timerEl) { timerEl.style.display = 'none'; timerEl.textContent = ''; }
      if (skipBtn) skipBtn.style.display = 'none';
      if (waitBtn) waitBtn.style.display = 'none';
      delete memberTimers[name];
      delete memberWaiting[name];
    }

    // Also update Level 3 status
    var l3col = document.querySelector('.l3-ai-col[data-ai="' + name + '"]');
    if (l3col) {
      var l3state = l3col.querySelector('.l3-ai-state');
      var l3vote = l3col.querySelector('.l3-ai-vote');
      l3state.textContent = statusLabels[status] || status;
      l3state.className = 'l3-ai-state';
      l3state.classList.add(statusClasses[status] || 'status-info');
      if (vote === 'YES') {
        l3vote.textContent = 'YAY';
        l3vote.className = 'l3-ai-vote vote-yes';
      } else if (vote === 'NO') {
        l3vote.textContent = 'NAY';
        l3vote.className = 'l3-ai-vote vote-no';
      } else {
        l3vote.textContent = '--';
        l3vote.className = 'l3-ai-vote vote-pending';
      }
    }
  }

  var renderedResponses = {}; // track "name:round" keys to avoid duplicates

  function updateResponses(responses, round) {
    for (var name in responses) {
      var text = responses[name];
      if (!text) continue;

      var key = name + ':' + (round || currentRound);
      if (renderedResponses[key]) continue;
      renderedResponses[key] = true;

      var col = document.querySelector('.ai-column[data-ai="' + name + '"]');
      if (!col) continue;
      var history = col.querySelector('.ai-response-history');
      if (!history) continue;

      // Create new entry for this round, prepend (latest on top)
      var entry = document.createElement('div');
      entry.className = 'ai-response-entry';

      var roundLabel = document.createElement('div');
      roundLabel.className = 'ai-response-round-label';
      roundLabel.textContent = 'ROUND ' + String(round || currentRound).padStart(2, '0');

      var content = document.createElement('div');
      content.textContent = text;

      entry.appendChild(roundLabel);
      entry.appendChild(content);

      // Prepend so latest is on top
      if (history.firstChild) {
        history.insertBefore(entry, history.firstChild);
      } else {
        history.appendChild(entry);
      }
    }
  }

  // ========== MESSAGE LOG ==========
  function addLogEntry(timestamp, source, content) {
    var logEl = document.getElementById('message-log');
    var entry = document.createElement('div');
    entry.className = 'log-entry';

    var ts = timestamp.replace('T', ' ').substring(11, 19);
    var tsSpan = document.createElement('span');
    tsSpan.className = 'log-timestamp';
    tsSpan.textContent = '[' + ts + '] ';

    var srcSpan = document.createElement('span');
    srcSpan.className = 'log-source';
    srcSpan.textContent = '[' + source.toUpperCase() + '] ';

    var contentSpan = document.createElement('span');
    contentSpan.className = 'log-content';
    contentSpan.textContent = content;

    entry.appendChild(tsSpan);
    entry.appendChild(srcSpan);
    entry.appendChild(contentSpan);
    logEl.appendChild(entry);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ========== INIT ==========
  function init() {
    // View switcher
    var buttons = document.querySelectorAll('#view-switcher button');
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var level = parseInt(btn.dataset.level, 10);
        switchLevel(level);
      });
    });

    // Chancellor buttons
    document.getElementById('btn-send').addEventListener('click', handleSend);
    document.getElementById('btn-abort').addEventListener('click', handleAbort);
    document.getElementById('prompt-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.ctrlKey) {
        handleSend();
      }
    });

    // Diagnose button
    document.getElementById('btn-diag').addEventListener('click', function () {
      window.council.diagnose().then(function (data) {
        console.log('DIAGNOSTIC:', data);
        var logEl = document.getElementById('message-log');
        for (var name in data) {
          var entry = document.createElement('div');
          entry.className = 'log-entry';
          entry.innerHTML = '<span class="log-source">[DIAG:' + name.toUpperCase() + ']</span> ' +
            '<span class="log-content">' + JSON.stringify(data[name].selectors || data[name]) + '</span>';
          logEl.appendChild(entry);
        }
      });
    });

    // Constitution toggle
    var constHeader = document.querySelector('.constitution-header');
    if (constHeader) {
      constHeader.addEventListener('click', function () {
        var body = document.querySelector('.constitution-body');
        if (body.style.display === 'none') {
          body.style.display = 'block';
          constHeader.textContent = 'CONSTITUTION [-]';
        } else {
          body.style.display = 'none';
          constHeader.textContent = 'CONSTITUTION [+]';
        }
      });
      // Start collapsed
      document.querySelector('.constitution-body').style.display = 'none';
      constHeader.textContent = 'CONSTITUTION [+]';
    }

    // File drag and drop
    initFileDrop();

    // IPC listeners
    window.council.onPhaseChange(function (data) {
      setPhase(data.phase);
      showStatus(phaseLabels[data.phase] || data.phase, phaseStatusType[data.phase] || 'info');
    });

    window.council.onAiStatus(function (data) {
      setAiStatus(data.name, data.status, data.vote);
    });

    window.council.onRoundUpdate(function (data) {
      setRound(data.round);
      updateResponses(data.responses, data.round);
    });

    window.council.onConsensus(function (data) {
      // If we have per-member answers, display them individually
      if (data.answers && Object.keys(data.answers).length > 0) {
        showConsensusWithMembers(data.answers, data.rounds, data.noConsensus);
      } else {
        showConsensus(data.answer, data.rounds, data.noConsensus);
      }
    });

    window.council.onIndividualConsensus(function (data) {
      // Show all individual member answers before unification
      var parts = [];
      for (var name in data.answers) {
        parts.push('=== ' + name.toUpperCase() + ' ===');
        parts.push(data.answers[name]);
        parts.push('');
      }
      var body = parts.join('\n');

      var area = document.getElementById('consensus-area');
      var header = document.getElementById('consensus-header');
      var bodyEl = document.getElementById('consensus-body');
      var meta = document.getElementById('consensus-meta');

      header.textContent = 'MEMBERS AGREE — UNIFYING ANSWER...';
      header.style.color = 'var(--yellow)';
      bodyEl.textContent = body;
      meta.textContent = 'AGREED AT ROUND ' + data.round + ' | UNIFICATION IN PROGRESS';
      area.classList.add('visible');
      document.getElementById('level-1').classList.add('has-consensus');
    });

    window.council.onLogMessage(function (data) {
      addLogEntry(data.timestamp, data.source, data.content);
    });

    window.council.onError(function (data) {
      showStatus('ERROR: ' + data, 'error');
    });

    window.council.onTimeoutTick(function (data) {
      // remaining is per-member ({claude: 42, gemini: 187, ...}) since each member
      // has its own timeout budget (Gemini runs much longer than Claude/Grok).
      var remainingByAi = data.remaining || {};
      var timerEls = document.querySelectorAll('.ai-timer');
      timerEls.forEach(function (el) {
        var aiName = el.dataset.ai;
        var remaining = remainingByAi[aiName];
        if (memberTimers[aiName] !== undefined && remaining !== undefined) {
          if (memberWaiting[aiName]) {
            el.textContent = 'WAIT';
          } else {
            el.textContent = remaining + 's';
          }
          el.style.display = '';
        }
      });
      // Show skip and wait buttons when 30s or less remaining
      var skipBtns = document.querySelectorAll('.btn-skip');
      skipBtns.forEach(function (btn) {
        var aiName = btn.dataset.ai;
        var remaining = remainingByAi[aiName];
        if (memberTimers[aiName] !== undefined && remaining !== undefined && remaining <= 30) {
          btn.style.display = '';
        }
      });
      var waitBtns = document.querySelectorAll('.btn-wait');
      waitBtns.forEach(function (btn) {
        var aiName = btn.dataset.ai;
        var remaining = remainingByAi[aiName];
        if (memberTimers[aiName] !== undefined && remaining !== undefined && remaining <= 30 && !memberWaiting[aiName]) {
          btn.style.display = '';
        }
      });
    });

    // Thought display handler
    window.council.onAiThought(function (data) {
      var col = document.querySelector('.ai-column[data-ai="' + data.name + '"]');
      if (!col) return;
      var el = col.querySelector('.ai-thought');
      if (el) {
        el.textContent = data.thought;
        el.className = 'ai-thought status-waiting';
      }
    });

    // Perf update handler
    window.council.onPerfUpdate(function (metrics) {
      // Find fastest and slowest for color-coding
      var values = [];
      ['claude', 'grok', 'gemini'].forEach(function (name) {
        if (metrics[name] && metrics[name] > 0) {
          values.push({ name: name, val: metrics[name] });
        }
      });
      values.sort(function (a, b) { return a.val - b.val; });

      ['claude', 'grok', 'gemini'].forEach(function (name) {
        var col = document.querySelector('.ai-column[data-ai="' + name + '"]');
        if (!col) return;
        var el = col.querySelector('.ai-speed');
        if (!el) return;

        var val = metrics[name];
        if (!val || val === 0) {
          el.textContent = '--';
          el.className = 'ai-speed status-info';
          return;
        }

        el.textContent = val.toFixed(1) + ' ms/char';

        // Color: fastest = green, slowest = yellow, middle = blue
        if (values.length > 0 && values[0].name === name) {
          el.className = 'ai-speed status-responded';
        } else if (values.length > 0 && values[values.length - 1].name === name) {
          el.className = 'ai-speed status-waiting';
        } else {
          el.className = 'ai-speed status-info';
        }
      });
    });

    // Nav button handlers
    var navBackBtns = document.querySelectorAll('.btn-nav-back');
    navBackBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        window.council.navBack(btn.dataset.ai);
      });
    });

    var navFwdBtns = document.querySelectorAll('.btn-nav-fwd');
    navFwdBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        window.council.navForward(btn.dataset.ai);
      });
    });

    // Login status listener
    window.council.onLoginStatus(function (status) {
      loginState = status;

      // Update Level 2 login indicators
      ['claude', 'grok', 'gemini'].forEach(function (name) {
        var col = document.querySelector('.ai-column[data-ai="' + name + '"]');
        if (!col) return;
        var el = col.querySelector('.ai-login-status');
        if (!el) return;
        if (status[name]) {
          el.textContent = 'LOGGED IN';
          el.className = 'ai-login-status status-responded';
        } else {
          el.textContent = 'LOGGED OUT';
          el.className = 'ai-login-status status-error';
        }
      });

      // Update Level 1 login warning
      var warning = document.getElementById('login-warning');
      if (warning) {
        if (status.claude && status.grok && status.gemini) {
          warning.style.display = 'none';
        } else {
          warning.style.display = '';
        }
      }

      // Auto-switch from login tab when all logged in
      if (status.claude && status.grok && status.gemini && !autoSwitchedFromLogin) {
        var activeBtn = document.querySelector('#view-switcher button.active');
        if (activeBtn && activeBtn.dataset.level === '0') {
          autoSwitchedFromLogin = true;
          switchLevel(1);
        }
      }
    });

    // Skip button handlers
    var skipBtns = document.querySelectorAll('.btn-skip');
    skipBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var aiName = btn.dataset.ai;
        window.council.skipMember(aiName);
        btn.style.display = 'none';
        // Also hide the wait button if visible
        var col = btn.closest('.ai-column');
        if (col) {
          var waitBtn = col.querySelector('.btn-wait');
          if (waitBtn) waitBtn.style.display = 'none';
        }
        delete memberWaiting[aiName];
      });
    });

    // Wait button handlers
    var waitBtns = document.querySelectorAll('.btn-wait');
    waitBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var aiName = btn.dataset.ai;
        window.council.waitMember(aiName);
        memberWaiting[aiName] = true;
        btn.style.display = 'none';
        // Update timer display immediately
        var col = btn.closest('.ai-column');
        if (col) {
          var timerEl = col.querySelector('.ai-timer');
          if (timerEl) timerEl.textContent = 'WAIT';
        }
      });
    });

    // Resize drag logic for Level 2 columns
    var resizeHandles = document.querySelectorAll('.ai-column-resize');
    resizeHandles.forEach(function (handle) {
      handle.addEventListener('mousedown', function (e) {
        e.preventDefault();
        var leftName = handle.dataset.left;
        var rightName = handle.dataset.right;
        var leftCol = document.querySelector('.ai-column[data-ai="' + leftName + '"]');
        var rightCol = document.querySelector('.ai-column[data-ai="' + rightName + '"]');
        if (!leftCol || !rightCol) return;

        var startX = e.clientX;
        var leftWidth = leftCol.getBoundingClientRect().width;
        var rightWidth = rightCol.getBoundingClientRect().width;

        handle.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        function onMouseMove(ev) {
          var delta = ev.clientX - startX;
          var newLeft = leftWidth + delta;
          var newRight = rightWidth - delta;
          if (newLeft < 100) { newLeft = 100; newRight = leftWidth + rightWidth - 100; }
          if (newRight < 100) { newRight = 100; newLeft = leftWidth + rightWidth - 100; }
          leftCol.style.flexBasis = newLeft + 'px';
          leftCol.style.flexGrow = '0';
          rightCol.style.flexBasis = newRight + 'px';
          rightCol.style.flexGrow = '0';
        }

        function onMouseUp() {
          handle.classList.remove('dragging');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
        }

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
