(() => {
  "use strict";

  const STORAGE_KEY = "vocab-trainer-state-v1";
  const ERROR_TAGS = ["对象错", "范围错", "褒贬错", "搭配错", "程度错", "望文生义", "语义重复", "其他"];
  const DEFAULT_SETTINGS = {
    dailyNew: 45,
    sessionSize: 20,
    intervals: [1, 3, 7, 14, 30],
    autoAdvance: true,
    instantSubmit: true
  };

  const MODE_LABELS = {
    due: "到期复习",
    new: "新词速刷",
    wrong: "错题强化",
    mixed: "混合测试"
  };

  let state = loadState();
  let pendingImportWords = null;
  let session = null;
  let currentQuestion = null;
  let selectedValue = null;
  let answered = false;
  let currentAttemptRecord = null;
  let editingWordId = null;
  let autoAdvanceTimer = null;

  const $ = (id) => document.getElementById(id);

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    bindEvents();
    renderAll();
  }

  function createInitialState() {
    const source = Array.isArray(window.SEED_WORDS) ? window.SEED_WORDS : [];
    const words = source.map((item, index) => normalizeWord(item, index)).filter(Boolean);

    return {
      version: 1,
      seedVersion: Number(window.SEED_VERSION || 1),
      createdAt: todayKey(),
      words,
      progress: {},
      attempts: [],
      settings: { ...DEFAULT_SETTINGS }
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return createInitialState();

      const saved = JSON.parse(raw);
      const fallback = createInitialState();
      const savedWords = Array.isArray(saved.words) ? saved.words : [];
      const versionChanged = Number(saved.seedVersion || 0) !== fallback.seedVersion;
      const upgradingSeed = versionChanged && savedWords.length <= 30;
      const seedById = new Map(fallback.words.map((word) => [word.id, word]));
      const seedByWord = new Map(fallback.words.map((word) => [word.word, word]));
      const mergedWords = savedWords.map((word) => {
        const seed = seedByWord.get(word.word) || seedById.get(word.id);
        return seed ? { ...seed, id: word.id || seed.id } : word;
      });
      const existingWords = new Set(mergedWords.map((word) => word.word));
      const missingSeedWords = versionChanged
        ? fallback.words.filter((word) => !existingWords.has(word.word))
        : [];
      const mergedWithNewWords = [...mergedWords, ...missingSeedWords];
      return {
        version: 1,
        seedVersion: fallback.seedVersion,
        createdAt: saved.createdAt || fallback.createdAt,
        words: upgradingSeed ? fallback.words : (savedWords.length ? mergedWithNewWords : fallback.words),
        progress: upgradingSeed ? {} : (saved.progress && typeof saved.progress === "object" ? saved.progress : {}),
        attempts: upgradingSeed ? [] : (Array.isArray(saved.attempts) ? saved.attempts : []),
        settings: {
          ...DEFAULT_SETTINGS,
          ...(saved.settings || {}),
          intervals: Array.isArray(saved.settings?.intervals) && saved.settings.intervals.length
            ? saved.settings.intervals
            : DEFAULT_SETTINGS.intervals
        }
      };
    } catch (error) {
      console.warn("无法读取本地学习记录，将使用内置题库。", error);
      return createInitialState();
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      console.warn("无法保存本地学习记录。", error);
      showToast("浏览器未能保存记录，请及时导出备份。");
    }
  }

  function bindEvents() {
    document.querySelectorAll(".nav-btn").forEach((button) => {
      button.addEventListener("click", () => showView(button.dataset.view));
    });

    document.querySelectorAll("[data-start-mode]").forEach((button) => {
      button.addEventListener("click", () => startSession(button.dataset.startMode));
    });

    $("startReviewBtn").addEventListener("click", () => startSession("due"));
    $("startNewBtn").addEventListener("click", () => startSession("new"));

    $("addWordBtn").addEventListener("click", () => openWordEditor(null));
    $("wordEditorCloseBtn").addEventListener("click", closeWordEditor);
    $("wordEditorCancelBtn").addEventListener("click", closeWordEditor);
    $("wordEditorSaveBtn").addEventListener("click", saveWordEditor);
    $("wordEditorForm").addEventListener("submit", (event) => { event.preventDefault(); saveWordEditor(); });
    $("headerImportBtn").addEventListener("click", openImportModal);
    $("libraryImportBtn").addEventListener("click", openImportModal);
    $("chapterImportBtn").addEventListener("click", openImportModal);
    $("chapterGrid").addEventListener("click", handleChapterAction);
    $("importCloseBtn").addEventListener("click", closeImportModal);
    $("fileInput").addEventListener("change", handleFileSelection);
    $("importConfirmBtn").addEventListener("click", confirmImport);
    $("downloadTemplateBtn").addEventListener("click", downloadTemplate);
    $("downloadTemplateDialogBtn").addEventListener("click", downloadTemplate);

    $("wordSearchInput").addEventListener("input", renderSearchResults);
    $("clearSearchBtn").addEventListener("click", () => { $("wordSearchInput").value = ""; renderSearchResults(); $("wordSearchInput").focus(); });
    $("librarySearch").addEventListener("input", renderLibrary);
    $("libraryStatus").addEventListener("change", renderLibrary);
    $("libraryPack").addEventListener("change", renderLibrary);

    $("settingsForm").addEventListener("submit", saveSettings);
    $("exportDataBtn").addEventListener("click", exportAllData);
    $("exportWrongBtn").addEventListener("click", exportWrongWords);
    $("resetProgressBtn").addEventListener("click", resetProgress);

    $("quizCloseBtn").addEventListener("click", closeQuiz);
    $("quizQuitBtn").addEventListener("click", closeQuiz);
    $("quizSubmitBtn").addEventListener("click", submitAnswer);
    $("quizNextBtn").addEventListener("click", nextQuestion);
    $("revealMeaningBtn").addEventListener("click", revealMeaning);
    $("rememberedBtn").addEventListener("click", () => assessCard(true));
    $("addWrongBookBtn").addEventListener("click", () => assessCard(false));
    $("startWrongBookBtn").addEventListener("click", () => startSession("wrong"));
    $("quizAutoAdvanceToggle").addEventListener("change", (event) => {
      state.settings.autoAdvance = event.target.checked;
      saveState();
      showToast(event.target.checked ? "选择“记住了”后将自动进入下一题。" : "选择后将停留在解析页。");
    });
    $("summaryCloseBtn").addEventListener("click", closeQuiz);
    $("summaryAgainBtn").addEventListener("click", retryWrongWords);

    document.addEventListener("keydown", handleKeyboard);
  }

  function showView(viewName) {
    document.querySelectorAll(".view").forEach((view) => {
      view.classList.toggle("active", view.id === `view-${viewName}`);
    });
    document.querySelectorAll(".nav-btn").forEach((button) => {
      button.classList.toggle("active", button.dataset.view === viewName);
    });

    if (viewName === "search") { renderSearchResults(); $("wordSearchInput").focus(); }
    if (viewName === "chapters") renderChapters();
    if (viewName === "wrongbook") renderWrongBook();
    if (viewName === "library") renderLibrary();
    if (viewName === "stats") renderStats();
    if (viewName === "settings") renderSettings();
  }

  function renderAll() {
    renderToday();
    renderChapters();
    renderWrongBook();
    renderLibrary();
    renderStats();
    renderSettings();
  }

  function isInWrongBook(wordId) {
    const progress = state.progress[wordId];
    return Boolean(progress && (progress.manualWrong || progress.wrongCount > 0));
  }

  function addToWrongBook(wordId, notify = true) {
    const progress = getOrCreateProgress(wordId);
    progress.manualWrong = true;
    progress.wrongCount = Math.max(progress.wrongCount || 0, 1);
    progress.correctStreak = 0;
    progress.stage = 0;
    progress.nextReview = todayKey();
    saveState();
    renderAll();
    if (notify) showToast("已加入错题本。");
  }

  function startSingleWord(wordId) {
    const word = state.words.find((item) => item.id === wordId);
    if (!word) return;
    startSessionFromWords([word], "search");
  }

  function renderSearchResults() {
    const input = $("wordSearchInput");
    const query = input.value.trim().toLowerCase();
    const container = $("searchResults");
    const empty = $("searchEmpty");
    container.replaceChildren();

    if (!query) {
      empty.textContent = "输入词语开始搜索。";
      empty.classList.remove("hidden");
      return;
    }

    const matches = state.words
      .map((word) => {
        const wordText = word.word.toLowerCase();
        const haystack = [word.word, word.meaning, word.pack, word.usage, word.confusable, word.tags, ...(word.examples || [])]
          .join(" ")
          .toLowerCase();
        let score = 0;
        if (wordText === query) score = 100;
        else if (wordText.startsWith(query)) score = 80;
        else if (wordText.includes(query)) score = 60;
        else if (haystack.includes(query)) score = 30;
        return { word, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.word.word.localeCompare(b.word.word, "zh-CN"))
      .slice(0, 80);

    if (!matches.length) {
      empty.textContent = `没有找到“${input.value.trim()}”。`;
      empty.classList.remove("hidden");
      return;
    }

    empty.classList.add("hidden");
    matches.forEach(({ word }) => {
      const status = getWordStatus(word.id);
      const inWrongBook = isInWrongBook(word.id);
      const card = document.createElement("article");
      card.className = "search-result-card";

      const head = document.createElement("div");
      head.className = "search-result-head";
      const left = document.createElement("div");
      const title = document.createElement("h3");
      title.className = "search-result-word";
      title.textContent = word.word;
      const meta = document.createElement("div");
      meta.className = "search-result-meta";
      meta.textContent = `${word.pack || "未分类"} · ${status.label}`;
      left.append(title, meta);
      head.append(left);

      const meaning = document.createElement("div");
      meaning.className = "search-result-meaning";
      meaning.textContent = word.meaning;

      const actions = document.createElement("div");
      actions.className = "search-result-actions";
      const studyButton = document.createElement("button");
      studyButton.type = "button";
      studyButton.className = "btn btn-primary";
      studyButton.textContent = "看词卡";
      studyButton.addEventListener("click", () => startSingleWord(word.id));

      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "btn btn-ghost";
      editButton.textContent = "编辑释义";
      editButton.addEventListener("click", () => openWordEditor(word));

      const wrongButton = document.createElement("button");
      wrongButton.type = "button";
      wrongButton.className = inWrongBook ? "btn btn-ghost" : "btn btn-danger";
      wrongButton.textContent = inWrongBook ? "移出错题本" : "加入错题本";
      wrongButton.addEventListener("click", () => {
        if (inWrongBook) removeFromWrongBook(word.id, false);
        else addToWrongBook(word.id);
        renderSearchResults();
      });

      actions.append(studyButton, editButton, wrongButton);
      card.append(head, meaning, actions);
      container.append(card);
    });
  }
  function openWordEditor(word = null) {
    editingWordId = word?.id || null;
    const examples = word ? (Array.isArray(word.examples) && word.examples.length ? word.examples : [word.example || ""]) : [];
    $("wordEditorTitle").textContent = word ? "编辑词条" : "新增词语";
    $("editorWordInput").value = word?.word || "";
    $("editorPackInput").value = word?.pack || "自定义词";
    $("editorMeaningInput").value = word?.meaning || "";
    $("editorUsageInput").value = word?.usage || "";
    $("editorScenarioInput").value = word?.scenario || "";
    $("editorExample1Input").value = examples[0] || "";
    $("editorExample2Input").value = examples[1] || "";
    $("editorExample3Input").value = examples[2] || "";
    $("wordEditorModal").classList.remove("hidden");
    $("editorWordInput").focus();
  }

  function closeWordEditor() {
    $("wordEditorModal").classList.add("hidden");
    editingWordId = null;
  }

  function saveWordEditor() {
    const wasEditing = Boolean(editingWordId);
    const wordText = $("editorWordInput").value.trim();
    const meaning = $("editorMeaningInput").value.trim();
    const pack = $("editorPackInput").value.trim() || "自定义词";
    if (!wordText || !meaning) {
      showToast("词语和完整释义不能为空。");
      return;
    }

    const duplicate = state.words.find((item) => item.word === wordText && item.id !== editingWordId);
    if (duplicate) {
      showToast(`“${wordText}”已经存在。`);
      return;
    }

    const examples = [
      $("editorExample1Input").value.trim(),
      $("editorExample2Input").value.trim(),
      $("editorExample3Input").value.trim()
    ].filter(Boolean).slice(0, 3);

    if (editingWordId) {
      const word = state.words.find((item) => item.id === editingWordId);
      if (!word) return;
      const oldMeaning = word.meaning;
      word.word = wordText;
      word.meaning = meaning;
      word.pack = pack;
      word.usage = $("editorUsageInput").value.trim();
      word.scenario = $("editorScenarioInput").value.trim();
      word.examples = examples;
      word.example = examples[0] || "";
      if (!word.confusable || word.confusable === oldMeaning) word.confusable = meaning;
    } else {
      const id = `custom-${hashString(`${pack}::${wordText}`)}`;
      state.words.push({
        id,
        pack,
        word: wordText,
        meaning,
        usage: $("editorUsageInput").value.trim(),
        scenario: $("editorScenarioInput").value.trim(),
        example: examples[0] || "",
        examples,
        confusable: meaning,
        tags: "手动添加"
      });
    }

    saveState();
    closeWordEditor();
    renderAll();
    showToast(wasEditing ? "词条已更新。" : "新词已加入词库。");
    renderSearchResults();
  }
  function handleChapterAction(event) {
    const button = event.target.closest("[data-chapter-action]");
    if (!button) return;
    startChapterSession(button.dataset.pack, button.dataset.chapterAction);
  }

  function renderChapters() {
    const grid = $("chapterGrid");
    if (!grid) return;
    grid.replaceChildren();

    const packs = [...new Set(state.words.map((word) => word.pack || "未分类"))]
      .sort((a, b) => {
        const matchA = a.match(/^(成语|实词)·第(\d+)组$/);
        const matchB = b.match(/^(成语|实词)·第(\d+)组$/);
        if (!matchA || !matchB) return a.localeCompare(b, "zh-CN");
        if (matchA[1] !== matchB[1]) return matchA[1] === "成语" ? -1 : 1;
        return Number(matchA[2]) - Number(matchB[2]);
      });

    $("chapterEmpty").classList.toggle("hidden", packs.length > 0);

    packs.forEach((pack) => {
      const words = state.words.filter((word) => (word.pack || "未分类") === pack);
      const mastered = words.filter((word) => getWordStatus(word.id).key === "green").length;
      const wrong = words.filter((word) => getWordStatus(word.id).key === "red").length;
      const due = words.filter((word) => {
        const progress = state.progress[word.id];
        return progress && progress.nextReview <= todayKey();
      }).length;
      const unseen = words.filter((word) => !state.progress[word.id]).length;
      const percent = words.length ? Math.round((mastered / words.length) * 100) : 0;

      const card = document.createElement("article");
      card.className = "chapter-card";

      const head = document.createElement("div");
      head.className = "chapter-head";
      const titleWrap = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = pack;
      const subtitle = document.createElement("small");
      subtitle.textContent = `${words.length}个词 · 已完成 ${mastered} 个`;
      titleWrap.append(title, subtitle);
      const percentLabel = document.createElement("span");
      percentLabel.textContent = `${percent}%`;
      head.append(titleWrap, percentLabel);

      const progress = document.createElement("div");
      progress.className = "chapter-progress";
      const progressHead = document.createElement("div");
      progressHead.className = "chapter-progress-head";
      const progressText = document.createElement("span");
      progressText.textContent = "章节掌握度";
      const progressValue = document.createElement("span");
      progressValue.textContent = `${mastered} / ${words.length}`;
      progressHead.append(progressText, progressValue);
      const bar = document.createElement("div");
      bar.className = "bar";
      const fill = document.createElement("span");
      fill.style.width = `${percent}%`;
      bar.append(fill);
      progress.append(progressHead, bar);

      const metrics = document.createElement("div");
      metrics.className = "chapter-metrics";
      [
        { label: "待复习", value: due },
        { label: "未学", value: unseen },
        { label: "红灯", value: wrong },
        { label: "已掌握", value: mastered }
      ].forEach((metric) => {
        const item = document.createElement("div");
        item.className = "chapter-metric";
        const value = document.createElement("strong");
        value.textContent = metric.value;
        const label = document.createElement("small");
        label.textContent = metric.label;
        item.append(value, label);
        metrics.append(item);
      });

      const actions = document.createElement("div");
      actions.className = "chapter-actions";
      [
        { action: "comprehensive", label: "开始复习", primary: true },
        { action: "wrong", label: "错题重练" }
      ].forEach((item) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `chapter-action${item.primary ? " primary" : ""}`;
        button.dataset.pack = pack;
        button.dataset.chapterAction = item.action;
        button.textContent = item.label;
        actions.append(button);
      });

      card.append(head, progress, metrics, actions);
      grid.append(card);
    });
  }

  function renderToday() {
    const due = getDueWords();
    const newWords = getNewWords();
    const wrong = getWrongWords();
    const todayAttempts = getTodayAttempts();
    const correctCount = todayAttempts.filter((attempt) => attempt.correct).length;
    const studiedToday = Object.values(state.progress).filter((progress) => progress.firstSeen === todayKey()).length;

    $("todayLabel").textContent = formatLongDate(todayKey());
    $("todaySummary").textContent = due.length
      ? `今天有 ${due.length} 个词到期。建议先完成复习，再从 ${newWords.length} 个未学词中安排新任务。`
      : `今天没有到期复习。可从 ${newWords.length} 个未学词中开始，完成后系统会自动安排下次复习。`;

    $("dueCount").textContent = due.length;
    $("newCount").textContent = newWords.length;
    $("newGoalText").textContent = `今日目标 ${state.settings.dailyNew} 个，已首次学习 ${studiedToday} 个`;
    $("wrongCount").textContent = wrong.length;

    if (todayAttempts.length) {
      $("todayAccuracy").textContent = `${Math.round((correctCount / todayAttempts.length) * 100)}%`;
      $("todayAttempts").textContent = `今天已作答 ${todayAttempts.length} 题`;
    } else {
      $("todayAccuracy").textContent = "--";
      $("todayAttempts").textContent = "今天还没有作答";
    }

    renderTodayAdvice(due, newWords, wrong, studiedToday);
    renderReviewForecast();
  }

  function renderTodayAdvice(due, newWords, wrong, studiedToday) {
    const container = $("todayAdvice");
    container.replaceChildren();

    const remainingNew = Math.max(state.settings.dailyNew - studiedToday, 0);
    const newTask = Math.min(remainingNew, newWords.length);
    const items = [
      {
        title: "先做到期复习",
        detail: due.length ? `${due.length} 个词到期，预计 ${estimateMinutes(due.length)} 分钟` : "暂无到期词"
      },
      {
        title: "再学新词",
        detail: newTask ? `建议今天完成 ${newTask} 个，分 ${Math.max(1, Math.ceil(newTask / 20))} 批进行` : "今日新词目标已完成"
      },
      {
        title: "清掉高频错词",
        detail: wrong.length ? `错题存量 ${wrong.length} 个，优先重练错误 2 次以上的词` : "暂时没有错题"
      },
      {
        title: "结束时主动回想",
        detail: "不看选项，尝试说出核心义、适用对象和易混词区别"
      }
    ];

    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "advice-item";
      const left = document.createElement("strong");
      left.textContent = item.title;
      const right = document.createElement("span");
      right.textContent = item.detail;
      row.append(left, right);
      container.append(row);
    });
  }

  function renderReviewForecast() {
    const container = $("reviewForecast");
    container.replaceChildren();

    for (let offset = 0; offset < 7; offset += 1) {
      const date = addDaysKey(offset);
      const count = Object.values(state.progress).filter((progress) => {
        if (offset === 0) return progress.nextReview <= date;
        return progress.nextReview === date;
      }).length;

      const row = document.createElement("div");
      row.className = "forecast-item";
      const label = document.createElement("strong");
      label.textContent = offset === 0 ? "今天" : offset === 1 ? "明天" : formatShortDate(date);
      const value = document.createElement("span");
      value.textContent = `${count} 个待复习`;
      row.append(label, value);
      container.append(row);
    }
  }

  function renderWrongBook() {
    const words = getWrongWords();
    const body = $("wrongBookTableBody");
    body.replaceChildren();

    words.forEach((word) => {
      const progress = state.progress[word.id] || {};
      const row = document.createElement("tr");
      const wordCell = document.createElement("td");
      wordCell.className = "word-cell";
      wordCell.textContent = word.word;
      const meaningCell = document.createElement("td");
      meaningCell.textContent = word.meaning;
      const packCell = document.createElement("td");
      packCell.textContent = word.pack || "未分类";
      const wrongCell = document.createElement("td");
      wrongCell.textContent = progress.wrongCount || 0;
      const reviewCell = document.createElement("td");
      reviewCell.textContent = formatShortDate(progress.nextReview);
      const actionCell = document.createElement("td");
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "small-action";
      removeButton.textContent = "移出错题本";
      removeButton.addEventListener("click", () => removeFromWrongBook(word.id));
      actionCell.append(removeButton);
      row.append(wordCell, meaningCell, packCell, wrongCell, reviewCell, actionCell);
      body.append(row);
    });

    $("wrongBookEmpty").classList.toggle("hidden", words.length > 0);
  }

  function removeFromWrongBook(wordId, notify = true) {
    const progress = state.progress[wordId];
    if (!progress) return;
    progress.manualWrong = false;
    progress.wrongCount = 0;
    progress.stage = Math.max(progress.stage || 0, 3);
    progress.nextReview = addDaysKey(1);
    saveState();
    renderAll();
    showToast("已移出错题本。");
  }
  function renderLibrary() {
    const packSelect = $("libraryPack");
    const selectedPack = packSelect.value || "all";
    const packs = [...new Set(state.words.map((word) => word.pack || "未分类"))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    packSelect.replaceChildren();
    packSelect.append(new Option("全部分类", "all"));
    packs.forEach((pack) => packSelect.append(new Option(pack, pack)));
    packSelect.value = packs.includes(selectedPack) ? selectedPack : "all";

    const keyword = $("librarySearch").value.trim().toLowerCase();
    const statusFilter = $("libraryStatus").value;
    const packFilter = packSelect.value;

    const rows = state.words.filter((word) => {
      const status = getWordStatus(word.id).key;
      const haystack = [word.word, word.meaning, word.pack, word.usage, word.confusable, word.tags]
        .join(" ")
        .toLowerCase();
      const matchesKeyword = !keyword || haystack.includes(keyword);
      const matchesStatus = statusFilter === "all" || status === statusFilter;
      const matchesPack = packFilter === "all" || word.pack === packFilter;
      return matchesKeyword && matchesStatus && matchesPack;
    });

    const body = $("libraryTableBody");
    body.replaceChildren();

    rows.forEach((word) => {
      const status = getWordStatus(word.id);
      const progress = state.progress[word.id] || {};
      const row = document.createElement("tr");

      const wordCell = document.createElement("td");
      wordCell.className = "word-cell";
      wordCell.textContent = word.word;

      const meaningCell = document.createElement("td");
      meaningCell.textContent = word.meaning;

      const packCell = document.createElement("td");
      packCell.textContent = word.pack || "未分类";

      const statusCell = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = `status-pill ${status.className}`;
      badge.textContent = status.label;
      statusCell.append(badge);

      const reviewCell = document.createElement("td");
      reviewCell.textContent = progress.nextReview ? formatShortDate(progress.nextReview) : "未安排";

      const scoreCell = document.createElement("td");
      const correct = progress.correctCount || 0;
      const wrong = progress.wrongCount || 0;
      scoreCell.textContent = `${correct} / ${wrong}`;

      row.append(wordCell, meaningCell, packCell, statusCell, reviewCell, scoreCell);
      body.append(row);
    });

    $("libraryEmpty").classList.toggle("hidden", rows.length > 0);
  }

  function renderStats() {
    const attempts = state.attempts;
    const correct = attempts.filter((attempt) => attempt.correct).length;
    const mastered = state.words.filter((word) => getWordStatus(word.id).key === "green").length;
    const errorCounts = {};

    state.words.forEach((word) => {
      const tags = state.progress[word.id]?.errorTags || {};
      Object.entries(tags).forEach(([tag, count]) => {
        errorCounts[tag] = (errorCounts[tag] || 0) + count;
      });
    });

    const topError = Object.entries(errorCounts).sort((a, b) => b[1] - a[1])[0];
    $("totalAttempts").textContent = attempts.length;
    $("totalAccuracy").textContent = attempts.length ? `${Math.round((correct / attempts.length) * 100)}%` : "--";
    $("masteredCount").textContent = mastered;
    $("topErrorTag").textContent = topError ? topError[0] : "--";

    const counts = {
      new: state.words.filter((word) => getWordStatus(word.id).key === "new").length,
      red: state.words.filter((word) => getWordStatus(word.id).key === "red").length,
      yellow: state.words.filter((word) => getWordStatus(word.id).key === "yellow").length,
      green: mastered
    };

    renderMasteryBars(counts);
    renderErrorTagStats(errorCounts);
    renderRecentAttempts();
  }

  function renderMasteryBars(counts) {
    const container = $("masteryBars");
    container.replaceChildren();
    const total = Math.max(state.words.length, 1);
    const rows = [
      { key: "new", label: "未学", color: "bar-new", count: counts.new },
      { key: "red", label: "红灯 · 重点复习", color: "bar-red", count: counts.red },
      { key: "yellow", label: "黄灯 · 仍需巩固", color: "bar-yellow", count: counts.yellow },
      { key: "green", label: "绿灯 · 已掌握", color: "bar-green", count: counts.green }
    ];

    rows.forEach((item) => {
      const row = document.createElement("div");
      row.className = "mastery-row";
      const head = document.createElement("div");
      head.className = "mastery-row-head";
      const label = document.createElement("span");
      label.textContent = item.label;
      const value = document.createElement("span");
      value.textContent = `${item.count} / ${state.words.length}`;
      head.append(label, value);

      const bar = document.createElement("div");
      bar.className = "bar";
      const fill = document.createElement("span");
      fill.className = item.color;
      fill.style.width = `${Math.round((item.count / total) * 100)}%`;
      bar.append(fill);
      row.append(head, bar);
      container.append(row);
    });
  }

  function renderErrorTagStats(errorCounts) {
    const container = $("errorTagStats");
    container.replaceChildren();
    const entries = Object.entries(errorCounts).sort((a, b) => b[1] - a[1]);

    if (!entries.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "还没有错因记录。答错后可以给题目打标签。";
      container.append(empty);
      return;
    }

    const max = Math.max(...entries.map((entry) => entry[1]), 1);
    entries.forEach(([tag, count]) => {
      const item = document.createElement("div");
      item.className = "tag-stat";
      const label = document.createElement("strong");
      label.textContent = tag;
      const value = document.createElement("span");
      value.textContent = `${count} 次`;
      const bar = document.createElement("div");
      bar.className = "bar";
      const fill = document.createElement("span");
      fill.className = "bar-red";
      fill.style.width = `${Math.round((count / max) * 100)}%`;
      bar.append(fill);
      item.append(label, value, bar);
      container.append(item);
    });
  }

  function renderRecentAttempts() {
    const container = $("recentAttempts");
    container.replaceChildren();
    const attempts = state.attempts.slice(0, 20);

    if (!attempts.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "完成第一轮刷题后，这里会显示记录。";
      container.append(empty);
      return;
    }

    attempts.forEach((attempt) => {
      const item = document.createElement("div");
      item.className = `attempt-item ${attempt.correct ? "correct" : "wrong"}`;
      const left = document.createElement("strong");
      left.textContent = `${attempt.word} · ${attempt.correct ? "正确" : "错误"}`;
      const right = document.createElement("span");
      const time = attempt.timestamp ? new Date(attempt.timestamp).toLocaleString("zh-CN", { hour12: false }) : "";
      const tags = attempt.tags?.length ? ` · ${attempt.tags.join("、")}` : "";
      right.textContent = `${time}${tags}`;
      item.append(left, right);
      container.append(item);
    });
  }

  function renderSettings() {
    $("dailyNewInput").value = state.settings.dailyNew;
    $("sessionSizeInput").value = state.settings.sessionSize;
    $("intervalsInput").value = state.settings.intervals.join(",");
    $("autoAdvanceInput").checked = state.settings.autoAdvance !== false;
    $("instantSubmitInput").checked = state.settings.instantSubmit !== false;
  }

  function saveSettings(event) {
    event.preventDefault();
    const dailyNew = clampNumber($("dailyNewInput").value, 1, 300, 45);
    const sessionSize = clampNumber($("sessionSizeInput").value, 5, 100, 20);
    const intervals = $("intervalsInput").value
      .split(/[,\s，]+/)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b);

    if (intervals.length < 2) {
      showToast("间隔天数至少填写两项，例如：1,3,7,14,30");
      return;
    }

    state.settings = {
      dailyNew,
      sessionSize,
      intervals,
      autoAdvance: $("autoAdvanceInput").checked,
      instantSubmit: $("instantSubmitInput").checked
    };
    saveState();
    renderToday();
    renderSettings();
    showToast("设置已保存，新的间隔会用于之后的复习安排。");
  }

  function startChapterSession(pack, questionType) {
    let words = state.words.filter((word) => (word.pack || "未分类") === pack);
    if (!words.length) {
      showToast("这个章节还没有词汇。");
      return;
    }

    const due = words.filter((word) => {
      const progress = state.progress[word.id];
      return progress && progress.nextReview <= todayKey();
    });
    const wrong = words.filter((word) => {
      const progress = state.progress[word.id];
      return progress && progress.wrongCount > 0 && progress.stage < 5;
    });
    const unseen = words.filter((word) => !state.progress[word.id]);
    const rest = words.filter((word) => !state.progress[word.id] || !due.includes(word) && !wrong.includes(word));

    if (questionType === "wrong") words = wrong;
    else words = dedupeById([...shuffle(due), ...shuffle(wrong), ...shuffle(unseen), ...shuffle(rest)]);

    words = words.slice(0, state.settings.sessionSize);
    if (!words.length) {
      showToast(questionType === "wrong" ? "这个章节暂时没有错题。" : "这个章节没有可练习的词汇。");
      return;
    }

    startSessionFromWords(words, "chapter", questionType === "comprehensive" ? "comprehensive" : questionType, pack);
  }

  function startSession(mode) {
    let words = [];
    let questionType = "comprehensive";

    if (mode === "due") words = getDueWords();
    if (mode === "new") {
      const studiedToday = Object.values(state.progress).filter((progress) => progress.firstSeen === todayKey()).length;
      const remaining = Math.max(state.settings.dailyNew - studiedToday, 0);
      const amount = Math.min(state.settings.sessionSize, remaining || state.settings.sessionSize);
      words = getNewWords().slice(0, amount);
    }
    if (mode === "wrong") {
      words = getWrongWords();
      questionType = "comprehensive";
    }
    if (mode === "mixed") {
      const due = shuffle(getDueWords());
      const fresh = shuffle(getNewWords());
      const dueTarget = Math.ceil(state.settings.sessionSize * 0.6);
      words = dedupeById([
        ...due.slice(0, dueTarget),
        ...fresh.slice(0, state.settings.sessionSize - Math.min(dueTarget, due.length))
      ]);
      if (words.length < state.settings.sessionSize) {
        const fallback = shuffle([...getWrongWords(), ...getWordsLearnedBeforeToday()]);
        words = dedupeById([...words, ...fallback]).slice(0, state.settings.sessionSize);
      }
    }

    words = shuffle(dedupeById(words)).slice(0, state.settings.sessionSize);
    if (!words.length) {
      showToast(mode === "due" ? "今天没有到期复习。" : "当前没有符合条件的词语。");
      return;
    }

    startSessionFromWords(words, mode, questionType);
  }

  function startSessionFromWords(words, mode, questionType = "comprehensive", pack = "") {
    clearAutoAdvanceTimer();
    session = {
      mode,
      pack,
      questionType,
      questions: words.map((word, index) => createQuestion(word, index, questionType)),
      index: 0,
      results: [],
      wrongWords: []
    };

    $("quizModal").classList.remove("hidden");
    renderQuestion();
  }

  function wordOption(item, correct) {
    return { value: item.word, correct, wordId: item.id, word: item.word, meaning: item.meaning || "" };
  }

  function meaningOption(item, correct) {
    return { value: item.meaning, correct, wordId: item.id, word: item.word, meaning: item.meaning || "" };
  }

  function createQuestion(word) {
    return {
      wordId: word.id,
      word: word.word,
      type: "card",
      typeLabel: "看词想义",
      prompt: "先回想这个词的意思和使用条件",
      stem: "",
      options: [],
      correctValue: "",
      explanation: buildExplanation(word),
      pack: word.pack
    };
  }
  function buildExplanation(word) {
    const parts = [`完整意思：${word.meaning}`];
    if (word.usage && word.usage !== word.meaning) parts.push(`使用条件：${word.usage}`);
    if (word.confusable && word.confusable !== word.meaning) parts.push(`易混辨析：${word.confusable}`);
    const examples = Array.isArray(word.examples) ? word.examples.filter(Boolean).slice(0, 3) : [];
    if (!examples.length && word.example) examples.push(word.example);
    examples.forEach((example, index) => parts.push(`【例${index + 1}】${example}`));
    if (word.tags) parts.push(`标签：${word.tags}`);
    return parts.join("\n");
  }

  function getClozeText(word) {
    const candidates = [word.example, ...(Array.isArray(word.examples) ? word.examples : [])]
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    const example = candidates.find((item) => item.includes(word.word)) ||
      candidates.find((item) => item.includes("___") || item.includes("______")) ||
      candidates[0] ||
      "";
    if (example && example.includes(word.word)) {
      return example.split(word.word).join("______");
    }
    if (example && (example.includes("___") || example.includes("______"))) {
      return example.replace(/_{2,}/g, "______");
    }
    const context = word.scenario || word.usage || word.meaning;
    if (context && context.includes(word.word)) {
      return context.split(word.word).join("______");
    }
    return `在需要表达“${context || word.word}”的语境中，应填入______。`;
  }

  function getScenarioText(word) {
    if (word.scenario) return word.scenario;
    if (word.usage) return `使用情境提示：${word.usage}`;
    if (word.example) return `请根据语境判断：${word.example.split("___").join("某个词").split(word.word).join("某个词")}`;
    return "";
  }

  function getDiscriminationText(word) {
    return word.confusable || word.usage || "";
  }

  function clearAutoAdvanceTimer() {
    if (autoAdvanceTimer) {
      window.clearTimeout(autoAdvanceTimer);
      autoAdvanceTimer = null;
    }
  }

  function renderQuestion() {
    if (!session) return;
    clearAutoAdvanceTimer();
    if (session.index >= session.questions.length) {
      renderSummary();
      return;
    }

    currentQuestion = session.questions[session.index];
    answered = false;
    currentAttemptRecord = null;

    $("quizQuestionArea").classList.remove("hidden");
    $("quizSummaryArea").classList.add("hidden");
    $("quizModeLabel").textContent = session.mode === "chapter"
      ? `章节 · ${session.pack || "未分类"}`
      : (MODE_LABELS[session.mode] || "刷题");
    const isCard = currentQuestion.type === "card";
    $("quizTitle").textContent = isCard ? "" : currentQuestion.word;
    $("quizTitle").classList.toggle("hidden", isCard);
    $("quizCounter").textContent = `${session.index + 1} / ${session.questions.length}`;
    $("quizProgress").style.width = `${Math.round((session.index / session.questions.length) * 100)}%`;
    $("questionTypeBadge").textContent = currentQuestion.typeLabel;
    $("questionPack").textContent = currentQuestion.pack || "未分类";
    $("questionMeta").classList.toggle("center", isCard);
    $("questionPrompt").classList.toggle("word-focus", isCard);
    $("questionPrompt").textContent = isCard ? currentQuestion.word : currentQuestion.prompt;
    $("questionStem").classList.add("hidden");
    $("optionList").classList.add("hidden");
    $("feedbackCard").classList.add("hidden");
    $("optionReview").classList.add("hidden");
    $("extraPractice").classList.add("hidden");
    $("errorTagSection").classList.add("hidden");
    $("selfAssessmentActions").classList.add("hidden");
    $("revealPanel").classList.remove("hidden");
    $("quizSubmitBtn").classList.add("hidden");
    $("quizNextBtn").classList.add("hidden");
    $("summaryAgainBtn").classList.add("hidden");
    $("summaryCloseBtn").classList.add("hidden");
    $("quizAutoAdvanceToggle").checked = state.settings.autoAdvance !== false;
  }

  function revealMeaning() {
    if (!currentQuestion) return;
    $("revealPanel").classList.add("hidden");
    $("feedbackCard").classList.remove("hidden");
    $("feedbackTitle").textContent = "完整解释";
    $("feedbackExplanation").textContent = currentQuestion.explanation;
    $("selfAssessmentActions").classList.remove("hidden");
    $("errorTagSection").classList.add("hidden");
  }

  function assessCard(isKnown) {
    if (!currentQuestion || answered) return;
    answered = true;
    recordAnswer(currentQuestion, isKnown);
    const progress = state.progress[currentQuestion.wordId];
    if (!isKnown && progress) {
      progress.manualWrong = true;
      saveState();
    }
    $("selfAssessmentActions").classList.add("hidden");
    $("feedbackTitle").textContent = isKnown
      ? `记住了 · 下次复习：${formatShortDate(progress.nextReview)}`
      : "已加入错题本 · 今天会再次复习";
    $("quizNextBtn").classList.remove("hidden");
    if (isKnown && state.settings.autoAdvance !== false) {
      const index = session.index;
      autoAdvanceTimer = window.setTimeout(() => {
        if (session && session.index === index && answered) nextQuestion();
      }, 850);
    }
  }

  function selectOption() {}

  function submitAnswer() {}
  function recordAnswer(question, isCorrect) {
    const word = state.words.find((item) => item.id === question.wordId);
    if (!word) return;

    const progress = getOrCreateProgress(word.id);
    const intervals = state.settings.intervals;
    progress.attemptCount = (progress.attemptCount || 0) + 1;
    progress.lastReview = todayKey();
    progress.lastResult = isCorrect ? "correct" : "wrong";

    if (isCorrect) {
      progress.correctCount = (progress.correctCount || 0) + 1;
      progress.correctStreak = (progress.correctStreak || 0) + 1;
      progress.stage = Math.min((progress.stage || 0) + 1, 5);
      const intervalIndex = Math.min(Math.max(progress.stage - 1, 0), intervals.length - 1);
      progress.nextReview = addDaysKey(intervals[intervalIndex]);
    } else {
      progress.wrongCount = (progress.wrongCount || 0) + 1;
      progress.correctStreak = 0;
      progress.stage = 0;
      progress.nextReview = todayKey();
    }

    currentAttemptRecord = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      wordId: word.id,
      word: word.word,
      type: question.type,
      correct: isCorrect,
      date: todayKey(),
      timestamp: new Date().toISOString(),
      tags: []
    };

    state.attempts.unshift(currentAttemptRecord);
    state.attempts = state.attempts.slice(0, 1500);
    session.results.push(currentAttemptRecord);
    if (!isCorrect && !session.wrongWords.includes(word.id)) session.wrongWords.push(word.id);

    saveState();
  }

  function renderAnswerFeedback(isCorrect) {
    document.querySelectorAll(".option").forEach((button) => {
      const isCorrectOption = button.dataset.value === currentQuestion.correctValue;
      const isSelected = button.dataset.value === selectedValue;
      button.disabled = true;
      button.classList.toggle("correct", isCorrectOption);
      button.classList.toggle("wrong", isSelected && !isCorrectOption);
      button.classList.remove("selected");
    });

    const progress = state.progress[currentQuestion.wordId];
    const feedback = $("feedbackCard");
    feedback.classList.remove("hidden");
    $("feedbackTitle").textContent = isCorrect
      ? `正确 · 下次复习：${formatShortDate(progress.nextReview)}`
      : "答错了 · 系统已将这个词安排为今天再次复习";
    $("feedbackExplanation").textContent = currentQuestion.explanation;
    renderOptionReview(isCorrect);
    renderExtraPractice(isCorrect);

    const tagSection = $("errorTagSection");
    tagSection.classList.toggle("hidden", isCorrect);
    if (!isCorrect) renderErrorTags();
    renderToday();
    renderStats();
  }

  function renderOptionReview(isCorrect) {
    const container = $("optionReview");
    container.replaceChildren();
    if (!isCorrect || !currentQuestion) {
      container.classList.add("hidden");
      return;
    }

    const title = document.createElement("div");
    title.className = "option-review-title";
    title.textContent = "本题所有选项对应的词语与释义";
    container.append(title);

    currentQuestion.options.forEach((option, index) => {
      const item = document.createElement("div");
      item.className = `option-review-item${option.correct ? " correct" : ""}`;
      const letter = String.fromCharCode(65 + index);
      let text;
      if (currentQuestion.type === "discrimination" && !option.correct) {
        text = `${letter}. 该项混入了“${option.word || "其他词"}”的释义：${option.meaning || option.value}`;
      } else {
        text = `${letter}. ${option.word || currentQuestion.word}：${option.meaning || option.value}`;
      }
      item.textContent = text;
      container.append(item);
    });

    container.classList.remove("hidden");
  }

  function getPracticeSentence(word) {
    const candidates = [word.example, ...(Array.isArray(word.examples) ? word.examples : [])]
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    const example = candidates.find((item) => item.includes(word.word)) ||
      candidates.find((item) => item.includes("___")) ||
      "";
    if (example.includes(word.word)) return example.replace(word.word, "___");
    return example;
  }

  function renderExtraPractice(isCorrect) {
    const container = $("extraPractice");
    container.replaceChildren();
    if (!currentQuestion || currentQuestion.type !== "discrimination") {
      container.classList.add("hidden");
      return;
    }

    const optionWords = dedupeById(
      currentQuestion.options
        .map((option) => state.words.find((word) => word.id === option.wordId))
        .filter(Boolean)
    );
    if (optionWords.length < 2) {
      container.classList.add("hidden");
      return;
    }

    const exercises = optionWords
      .map((word) => ({ word, sentence: getPracticeSentence(word) }))
      .filter((item) => item.sentence);
    if (!exercises.length) {
      container.classList.add("hidden");
      return;
    }

    const title = document.createElement("div");
    title.className = "extra-practice-title";
    title.textContent = "实际句子选词填空";
    container.append(title);

    exercises.slice(0, 3).forEach((exercise, index) => {
      const distractors = sampleUnique(
        optionWords.filter((word) => word.id !== exercise.word.id),
        2,
        (word) => word.word
      );
      const choices = shuffle([exercise.word.word, ...distractors.map((word) => word.word)]);
      let answered = false;

      const card = document.createElement("div");
      card.className = "extra-exercise";
      const prompt = document.createElement("div");
      prompt.className = "extra-prompt";
      prompt.textContent = `${index + 1}. ${exercise.sentence}`;
      const options = document.createElement("div");
      options.className = "extra-options";
      const note = document.createElement("div");
      note.className = "extra-note hidden";

      choices.forEach((choice) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "mini-option";
        button.textContent = choice;
        button.addEventListener("click", () => {
          if (answered) return;
          answered = true;
          const correct = choice === exercise.word.word;
          options.querySelectorAll(".mini-option").forEach((item) => {
            item.disabled = true;
            item.classList.toggle("correct", item.textContent === exercise.word.word);
            item.classList.toggle("wrong", item.textContent === choice && !correct);
          });
          note.textContent = `${correct ? "正确" : "答错"}：${exercise.word.word}——${exercise.word.meaning}`;
          note.classList.remove("hidden");
        });
        options.append(button);
      });

      card.append(prompt, options, note);
      container.append(card);
    });

    container.classList.remove("hidden");
  }
  function renderErrorTags() {
    const container = $("errorTagChips");
    container.replaceChildren();
    ERROR_TAGS.forEach((tag) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chip";
      button.textContent = tag;
      button.addEventListener("click", () => {
        const active = !button.classList.contains("active");
        button.classList.toggle("active", active);
        toggleAttemptTag(tag, active);
      });
      container.append(button);
    });
  }

  function toggleAttemptTag(tag, active) {
    if (!currentAttemptRecord) return;
    const record = currentAttemptRecord;
    const progress = state.progress[record.wordId];
    if (!progress) return;
    progress.errorTags = progress.errorTags || {};

    const hasTag = record.tags.includes(tag);
    if (active && !hasTag) {
      record.tags.push(tag);
      progress.errorTags[tag] = (progress.errorTags[tag] || 0) + 1;
    }
    if (!active && hasTag) {
      record.tags = record.tags.filter((item) => item !== tag);
      progress.errorTags[tag] = Math.max((progress.errorTags[tag] || 1) - 1, 0);
      if (progress.errorTags[tag] === 0) delete progress.errorTags[tag];
    }
    saveState();
  }

  function nextQuestion() {
    if (!session) return;
    session.index += 1;
    renderQuestion();
  }

  function renderSummary() {
    const total = session.results.length;
    const correct = session.results.filter((result) => result.correct).length;
    const wrong = total - correct;
    const percent = total ? Math.round((correct / total) * 100) : 0;

    $("quizQuestionArea").classList.add("hidden");
    $("quizSummaryArea").classList.remove("hidden");
    $("quizProgress").style.width = "100%";
    $("quizCounter").textContent = `${total} / ${total}`;
    $("summaryRing").textContent = `${percent}%`;
    $("summaryTitle").textContent = percent >= 80 ? "本轮掌握良好" : "本轮需要巩固";
    $("summaryText").textContent = wrong
      ? `答错 ${wrong} 题。错词已经进入复习队列，建议立即再做一次或明天优先复习。`
      : "本轮全部正确。达到间隔后会再次出现，避免短期遗忘。";

    const stats = $("summaryStats");
    stats.replaceChildren();
    [
      { value: total, label: "完成题数" },
      { value: correct, label: "正确" },
      { value: wrong, label: "错误" }
    ].forEach((item) => {
      const card = document.createElement("div");
      card.className = "summary-stat";
      const value = document.createElement("strong");
      value.textContent = item.value;
      const label = document.createElement("span");
      label.textContent = item.label;
      card.append(value, label);
      stats.append(card);
    });

    $("quizSubmitBtn").classList.add("hidden");
    $("quizNextBtn").classList.add("hidden");
    $("summaryAgainBtn").classList.toggle("hidden", !session.wrongWords.length);
    $("summaryCloseBtn").classList.remove("hidden");
    renderToday();
    renderLibrary();
    renderStats();
  }

  function retryWrongWords() {
    if (!session?.wrongWords?.length) return;
    const words = state.words.filter((word) => session.wrongWords.includes(word.id));
    startSessionFromWords(words, "wrong");
  }

  function closeQuiz() {
    clearAutoAdvanceTimer();
    session = null;
    currentQuestion = null;
    selectedValue = null;
    answered = false;
    currentAttemptRecord = null;
    $("quizModal").classList.add("hidden");
    renderAll();
  }

  function handleKeyboard(event) {
    if ($("quizModal").classList.contains("hidden") || !session || session.index >= session.questions.length) return;

    if (!answered && /^[1-4]$/.test(event.key)) {
      const index = Number.parseInt(event.key, 10) - 1;
      const option = currentQuestion.options[index];
      if (option) selectOption(option.value);
    }

    if (event.key === "Enter") {
      if (!answered && selectedValue != null) submitAnswer();
      else if (answered) nextQuestion();
    }
  }

  function getOrCreateProgress(wordId) {
    if (!state.progress[wordId]) {
      state.progress[wordId] = {
        stage: 0,
        correctStreak: 0,
        correctCount: 0,
        wrongCount: 0,
        attemptCount: 0,
        firstSeen: todayKey(),
        lastReview: "",
        lastResult: "",
        nextReview: todayKey(),
        errorTags: {}
      };
    }
    return state.progress[wordId];
  }

  function getWordStatus(wordId) {
    const progress = state.progress[wordId];
    if (!progress) return { key: "new", label: "未学", className: "status-new" };
    if (progress.stage >= 5) return { key: "green", label: "已掌握", className: "status-green" };
    const isRed = progress.wrongCount >= 2 || (progress.wrongCount > 0 && progress.stage <= 1);
    if (isRed) return { key: "red", label: "红灯", className: "status-red" };
    return { key: "yellow", label: "黄灯", className: "status-yellow" };
  }

  function getDueWords() {
    const today = todayKey();
    return state.words.filter((word) => {
      const progress = state.progress[word.id];
      return progress && progress.nextReview && progress.nextReview <= today;
    });
  }

  function getNewWords() {
    return state.words.filter((word) => !state.progress[word.id]);
  }

  function getWrongWords() {
    return state.words
      .filter((word) => {
        const progress = state.progress[word.id];
        return progress && (progress.manualWrong || progress.wrongCount > 0) && progress.stage < 5;
      })
      .sort((a, b) => {
        const pa = state.progress[a.id];
        const pb = state.progress[b.id];
        return (pb.wrongCount - pa.wrongCount) || (pa.stage - pb.stage);
      });
  }

  function getWordsLearnedBeforeToday() {
    return state.words.filter((word) => {
      const progress = state.progress[word.id];
      return progress && progress.firstSeen < todayKey();
    });
  }

  function getTodayAttempts() {
    return state.attempts.filter((attempt) => attempt.date === todayKey());
  }

  function openImportModal() {
    $("importModal").classList.remove("hidden");
    $("importPreview").classList.add("hidden");
    $("importPreview").textContent = "";
    $("fileInput").value = "";
    $("importConfirmBtn").disabled = true;
    pendingImportWords = null;
  }

  function closeImportModal() {
    $("importModal").classList.add("hidden");
  }

  async function handleFileSelection(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const rows = file.name.toLowerCase().endsWith(".json") ? JSON.parse(text) : parseCSV(text);
      const rawWords = Array.isArray(rows) ? rows : rows.words;
      if (!Array.isArray(rawWords)) throw new Error("文件格式不是词汇数组。");

      const words = rawWords.map((item, index) => normalizeWord(item, index)).filter(Boolean);
      if (!words.length) throw new Error("没有识别到有效词汇，请检查“词语、释义”两列。");

      pendingImportWords = words;
      const preview = words.slice(0, 5).map((word) => word.word).join("、");
      $("importPreview").textContent = `识别到 ${words.length} 个词；预览：${preview}${words.length > 5 ? "……" : ""}`;
      $("importPreview").classList.remove("hidden");
      $("importConfirmBtn").disabled = false;
    } catch (error) {
      pendingImportWords = null;
      $("importPreview").textContent = `导入失败：${error.message}`;
      $("importPreview").classList.remove("hidden");
      $("importConfirmBtn").disabled = true;
    }
  }

  function confirmImport() {
    if (!pendingImportWords?.length) return;
    const merge = $("mergeImportInput").checked;
    let progress = { ...state.progress };

    if (!merge) {
      const oldWords = new Map(state.words.map((word) => [word.id, word]));
      state.words = pendingImportWords.map((word) => {
        const old = oldWords.get(word.id);
        if (old) progress[word.id] = state.progress[word.id];
        return word;
      });
    } else {
      const byId = new Map(state.words.map((word) => [word.id, word]));
      const byPackWord = new Map(state.words.map((word) => [`${word.pack || ""}::${word.word}`, word]));
      pendingImportWords.forEach((word) => {
        const existing = byId.get(word.id) || byPackWord.get(`${word.pack || ""}::${word.word}`);
        if (existing) {
          Object.assign(existing, word, { id: existing.id });
          byId.set(existing.id, existing);
          byPackWord.set(`${existing.pack || ""}::${existing.word}`, existing);
        } else {
          state.words.push(word);
          byId.set(word.id, word);
          byPackWord.set(`${word.pack || ""}::${word.word}`, word);
        }
      });
    }

    state.words = dedupeById(state.words);
    state.progress = progress;
    saveState();
    closeImportModal();
    renderAll();
    showToast(`已导入 ${pendingImportWords.length} 个词，现有词库共 ${state.words.length} 个。`);
    pendingImportWords = null;
  }

  function parseExamples(raw) {
    const result = [];
    const arrayValue = readField(raw, ["examples", "例句组", "多例句"]);
    if (Array.isArray(arrayValue)) result.push(...arrayValue);
    if (typeof arrayValue === "string") result.push(...arrayValue.split(/\s*\|\|\s*|\r?\n/));
    ["例句", "例句1", "例句2", "例句3"].forEach((field) => {
      const value = readField(raw, [field]);
      if (typeof value === "string" && value.trim()) result.push(...value.split(/\s*\|\|\s*|\r?\n/));
    });
    return [...new Set(result.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 3);
  }

  function normalizeWord(raw, index = 0) {
    if (!raw || typeof raw !== "object") return null;
    const word = String(readField(raw, ["word", "词语", "成语", "实词", "词"]) || "").trim();
    const meaning = String(readField(raw, ["meaning", "释义", "意思", "核心意思", "词义"]) || "").trim();
    if (!word || !meaning) return null;

    const pack = String(readField(raw, ["pack", "分类", "章节", "章", "词包", "单元"]) || "未分类").trim() || "未分类";
    const idValue = String(readField(raw, ["id", "编号"]) || "").trim();
    const examples = parseExamples(raw);
    const exampleValue = String(readField(raw, ["example", "例句", "语境"]) || "").trim();
    return {
      id: idValue || `import-${hashString(`${pack}::${word}`)}`,
      pack,
      word,
      meaning,
      usage: String(readField(raw, ["usage", "用法", "使用条件", "适用条件"]) || "").trim(),
      scenario: String(readField(raw, ["scenario", "场景", "使用场景", "语境场景"]) || "").trim(),
      example: examples[0] || exampleValue,
      examples,
      confusable: String(readField(raw, ["confusable", "易混词", "辨析", "易混辨析"]) || "").trim(),
      tags: arrayOrString(readField(raw, ["tags", "标签", "错因"]))
    };
  }

  function readField(object, aliases) {
    for (const alias of aliases) {
      if (Object.prototype.hasOwnProperty.call(object, alias)) return object[alias];
    }
    const lowerMap = Object.fromEntries(Object.keys(object).map((key) => [key.trim().toLowerCase(), object[key]]));
    for (const alias of aliases) {
      const value = lowerMap[alias.toLowerCase()];
      if (value !== undefined) return value;
    }
    return "";
  }

  function arrayOrString(value) {
    if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean).join(",");
    return String(value || "").trim();
  }

  function parseCSV(text) {
    const source = text.replace(/^\uFEFF/, "");
    const delimiter = source.includes("\t") && !source.includes(",") ? "\t" : ",";
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;

    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      const next = source[index + 1];

      if (char === '"') {
        if (inQuotes && next === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === delimiter && !inQuotes) {
        row.push(field);
        field = "";
      } else if ((char === "\n" || char === "\r") && !inQuotes) {
        if (char === "\r" && next === "\n") index += 1;
        row.push(field);
        if (row.some((cell) => cell.trim() !== "")) rows.push(row);
        row = [];
        field = "";
      } else {
        field += char;
      }
    }

    if (field || row.length) {
      row.push(field);
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
    }

    if (rows.length < 2) return [];
    const headers = rows[0].map((header) => header.trim().replace(/^\uFEFF/, ""));
    return rows.slice(1).map((cells) => {
      const record = {};
      headers.forEach((header, index) => {
        record[header] = (cells[index] || "").trim();
      });
      return record;
    });
  }

  function downloadTemplate() {
    const header = "id,分类,词语,释义,用法,场景,例句,易混词,标签";
    const rows = [
      ["demo-1", "选词1", "示例词", "这里写核心意思", "这里写使用对象或条件", "这里写一个不出现目标词的使用场景。", "这里写一个包含___的例句。", "这里写与什么词易混", "对象错,搭配错"],
      ["demo-2", "选词1", "另一个词", "这里写核心意思", "这里写使用对象或条件", "这里写一个不出现目标词的使用场景。", "这里写一个包含___的例句。", "这里写辨析", "褒贬错"]
    ];
    const csv = [header, ...rows.map((row) => row.map(csvEscape).join(","))].join("\r\n");
    downloadText("1000词导入模板.csv", `\uFEFF${csv}`, "text/csv;charset=utf-8");
  }

  function exportAllData() {
    downloadText(`1000词学习备份-${todayKey()}.json`, JSON.stringify(state, null, 2), "application/json;charset=utf-8");
  }

  function exportWrongWords() {
    const header = "词语,核心意思,分类,错误次数,当前阶段,错因,下次复习";
    const rows = getWrongWords().map((word) => {
      const progress = state.progress[word.id];
      const tags = Object.entries(progress.errorTags || {}).map(([tag, count]) => `${tag}(${count})`).join(" ");
      return [word.word, word.meaning, word.pack, progress.wrongCount, progress.stage, tags, progress.nextReview];
    });
    const csv = [header, ...rows.map((row) => row.map(csvEscape).join(","))].join("\r\n");
    downloadText(`1000词错题清单-${todayKey()}.csv`, `\uFEFF${csv}`, "text/csv;charset=utf-8");
  }

  function resetProgress() {
    const confirmed = window.confirm("确定清空所有作答记录、掌握度和复习时间吗？题库会保留。");
    if (!confirmed) return;
    state.progress = {};
    state.attempts = [];
    saveState();
    renderAll();
    showToast("学习进度已清空，题库仍保留。");
  }

  function downloadText(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function csvEscape(value) {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function showToast(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.remove("hidden");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.add("hidden"), 2800);
  }

  function shuffle(items) {
    const array = [...items];
    for (let index = array.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [array[index], array[randomIndex]] = [array[randomIndex], array[index]];
    }
    return array;
  }

  function sampleUnique(items, amount, getKey = (item) => item) {
    const unique = new Map();
    items.forEach((item) => {
      const key = getKey(item);
      if (!unique.has(key)) unique.set(key, item);
    });
    return shuffle([...unique.values()]).slice(0, amount);
  }

  function dedupeById(items) {
    const map = new Map();
    items.forEach((item) => {
      if (item?.id) map.set(item.id, item);
    });
    return [...map.values()];
  }

  function estimateMinutes(count) {
    return Math.max(1, Math.ceil(count * 0.4));
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(Math.max(number, min), max);
  }

  function todayKey() {
    return toDateKey(new Date());
  }

  function toDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function addDaysKey(days) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + Number(days || 0));
    return toDateKey(date);
  }

  function formatShortDate(dateKey) {
    if (!dateKey) return "--";
    if (dateKey === todayKey()) return "今天";
    if (dateKey === addDaysKey(1)) return "明天";
    const [, month, day] = dateKey.split("-");
    return `${Number(month)}月${Number(day)}日`;
  }

  function formatLongDate(dateKey) {
    const date = new Date(`${dateKey}T12:00:00`);
    return date.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "long"
    });
  }

  function hashString(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }
})();













































