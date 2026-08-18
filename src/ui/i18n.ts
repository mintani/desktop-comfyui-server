/**
 * What the management UI says, in every language it says it in.
 *
 * To add one — Simplified Chinese would be
 * `{ code: "zh", label: "CN", name: "简体中文", locale: "zh-CN" }` — put it in
 * `LANGS` and run `bun run check-types`. Every string that still needs
 * translating fails to compile, so nothing can be missed and no list has to be
 * kept by hand: the header switch and `<html lang>` both follow `LANGS`.
 *
 * `LANGS[0]` is what the UI opens in. The browser's own language is
 * deliberately not consulted: the README and the log lines are English, so a UI
 * that quietly starts in another one is harder to talk about, not easier.
 *
 * Static markup carries `data-i18n` and is translated in place; anything built
 * in JavaScript calls `t()`. Errors coming back from the server are passed
 * through as they are — they name fields, files and hosts the API knows about,
 * and translating them would mean a second protocol between the two halves.
 */

export const LANGS = [
  /** `label` is the switch, `name` names the language in itself. */
  { code: "en", label: "EN", name: "English", locale: "en-GB" },
  { code: "ja", label: "JP", name: "日本語", locale: "ja-JP" },
] as const;

export type Lang = (typeof LANGS)[number]["code"];

type Entry = Record<Lang, string>;

const STRINGS = {
  // Header ------------------------------------------------------------------
  "theme.label": { en: "Theme", ja: "テーマ" },
  "theme.light": { en: "Light", ja: "ライト" },
  "theme.dark": { en: "Dark", ja: "ダーク" },
  "theme.system": { en: "System", ja: "システム" },
  "lang.label": { en: "Language", ja: "言語" },

  // What this machine will start ---------------------------------------------
  "mode.label": { en: "Generation", ja: "生成" },
  "mode.accepting": { en: "Accepting", ja: "受付中" },
  "mode.acceptingNote": {
    en: "Jobs from your job servers, and runs started here.",
    ja: "ジョブサーバーからの仕事も、ここからの実行も動きます。",
  },
  "mode.local": { en: "Not accepting", ja: "受付停止" },
  "mode.localNote": {
    en: "Job servers get nothing. ComfyUI stays up for your own runs.",
    ja: "ジョブサーバーからは受け取りません。ComfyUI はそのまま、自分の実行は動きます。",
  },
  "mode.paused": { en: "Stopped", ja: "停止" },
  "mode.pausedNote": {
    en: "ComfyUI is shut down. Nothing runs until you pick another.",
    ja: "ComfyUI を終了します。他を選ぶまで何も動きません。",
  },
  "mode.stopConfirm": {
    en: "Stop generation on this machine?\n\nComfyUI is shut down, so anything still generating is lost.",
    ja: "このマシンの生成を停止しますか？\n\nComfyUI を終了するため、生成中のものは失われます。",
  },
  "mode.stopping": { en: "stopping ComfyUI…", ja: "ComfyUI を終了しています…" },
  "mode.needsComfy": {
    en: "start ComfyUI before choosing what it takes on",
    ja: "先に ComfyUI を起動してください",
  },
  "mode.saveFailed": { en: "could not change it", ja: "変更できませんでした" },

  // When jobs are accepted, on top of the mode -------------------------------
  "accept.title": { en: "Accepting jobs", ja: "ジョブの受付" },
  "accept.help": {
    en: "When job servers get work out of this machine. Runs you start here, and ComfyUI itself, are not affected.",
    ja: "ジョブサーバーからの仕事をいつ受けるかの設定です。ここから始める実行と ComfyUI 自体には影響しません。",
  },
  "accept.pauseFor": { en: "Hold off for", ja: "一時停止" },
  "accept.pause15": { en: "15 min", ja: "15分" },
  "accept.pause30": { en: "30 min", ja: "30分" },
  "accept.pause60": { en: "1 hour", ja: "1時間" },
  "accept.resume": { en: "Resume now", ja: "すぐ再開" },
  "accept.pausedUntil": {
    en: "On hold until {time}, {minutes} min left.",
    ja: "{time} まで停止中です。あと {minutes} 分。",
  },
  "accept.notPaused": { en: "Not on hold.", ja: "一時停止していません。" },
  "accept.schedule": { en: "Every day", ja: "毎日" },
  "accept.scheduleOn": {
    en: "Only accept between these times",
    ja: "この時間帯だけ受け付ける",
  },
  "accept.from": { en: "From", ja: "開始" },
  "accept.to": { en: "To", ja: "終了" },
  "accept.overnight": {
    en: "An end before the start runs overnight — 22:00 to 06:00 is tonight until tomorrow morning.",
    ja: "終了が開始より前なら日をまたぎます。22:00〜06:00 は今夜から翌朝までです。",
  },
  "accept.saved": { en: "saved", ja: "保存しました" },
  "accept.saveFailed": { en: "could not save it", ja: "保存できませんでした" },
  "accept.paused": { en: "on hold {minutes}m", ja: "停止中 あと{minutes}分" },
  "accept.outside": { en: "outside the window", ja: "時間帯外" },
  "accept.gatePaused": {
    en: "Jobs are on hold for another {minutes} min. Runs started here still go.",
    ja: "あと {minutes} 分はジョブを受けません。ここからの実行は動きます。",
  },
  "accept.gateSchedule": {
    en: "Outside {from}–{to}, so nothing is claimed. Runs started here still go.",
    ja: "{from}〜{to} の外なのでジョブは受けません。ここからの実行は動きます。",
  },

  // The desktop menu, mirrored by the tray -----------------------------------
  "desktop.title": { en: "Desktop app", ja: "デスクトップアプリ" },
  "desktop.autostart": { en: "Start when the computer starts", ja: "PC 起動時に起動する" },
  "desktop.closeAction": { en: "Closing the window", ja: "ウィンドウを閉じたとき" },
  "desktop.toTray": { en: "Keeps running", ja: "常駐する" },
  "desktop.quit": { en: "Quits", ja: "終了する" },
  "desktop.note": {
    en: "These apply to the desktop app. In a browser tab they do nothing.",
    ja: "デスクトップアプリでのみ効きます。ブラウザのタブでは何も起きません。",
  },
  "desktop.saved": { en: "saved", ja: "保存しました" },
  "desktop.saveFailed": { en: "save failed", ja: "保存できませんでした" },

  "nav.label": { en: "Sections", ja: "セクション" },
  "nav.settings": { en: "Settings", ja: "設定" },
  "nav.generate": { en: "Generate", ja: "生成" },

  // Status chips ------------------------------------------------------------
  "vitals.comfy": { en: "ComfyUI", ja: "ComfyUI" },
  "vitals.running": { en: "running", ja: "実行中" },
  "vitals.pending": { en: "pending", ja: "待機" },
  "vitals.agent": { en: "agent", ja: "エージェント" },
  "vitals.standalone": { en: "standalone", ja: "単独" },
  "vitals.process": { en: "process", ja: "プロセス" },
  "vitals.access": { en: "access", ja: "アクセス" },
  "vitals.work": { en: "work", ja: "受付" },
  "vitals.tokenNeeded": {
    en: "open this page as ?token=<UI_TOKEN>",
    ja: "?token=<UI_TOKEN> を付けて開いてください",
  },
  "vitals.unreachable": { en: "server unreachable", ja: "サーバーに接続できません" },

  "comfy.available": { en: "available", ja: "待機中" },
  "comfy.busy": { en: "busy", ja: "実行中" },
  "comfy.unavailable": { en: "unavailable", ja: "停止中" },

  // Run ---------------------------------------------------------------------
  "run.title": { en: "Run", ja: "実行" },
  "run.interrupt": { en: "Interrupt", ja: "中断" },
  "run.workflow": { en: "Workflow", ja: "ワークフロー" },
  "run.positive": { en: "Positive prompt", ja: "ポジティブプロンプト" },
  "run.negative": { en: "Negative prompt", ja: "ネガティブプロンプト" },
  "run.promptPlaceholder": {
    en: "keep the workflow's own prompt",
    ja: "ワークフローの内容をそのまま使う",
  },
  "run.seed": { en: "Seed", ja: "シード" },
  "run.random": { en: "random", ja: "ランダム" },
  "run.seconds": { en: "Seconds", ja: "秒数" },
  "run.fps": { en: "FPS", ja: "FPS" },
  "run.default": { en: "default", ja: "既定値" },
  "run.image": { en: "Input image", ja: "入力画像" },
  "run.submit": { en: "Run", ja: "実行" },
  "run.paused": { en: "new work is paused", ja: "新規の受付を停止中です" },
  "run.queueing": { en: "queueing…", ja: "送信中…" },
  "run.queued": { en: "queued — it appears in Runs", ja: "送信しました。実行履歴に出ます" },
  "run.interruptSent": { en: "interrupt sent", ja: "中断を送信しました" },
  "run.interruptFailed": { en: "interrupt failed", ja: "中断できませんでした" },

  // Runs --------------------------------------------------------------------
  "jobs.title": { en: "Runs", ja: "実行履歴" },
  "jobs.clear": { en: "Clear finished", ja: "完了分を削除" },
  "jobs.clearConfirm": {
    en: "Clear every finished job from the history?",
    ja: "完了したジョブを履歴からすべて削除しますか？",
  },
  "jobs.empty": {
    en: "Nothing has run yet. Fill in the form and press Run.",
    ja: "まだ何も実行していません。フォームを入力して実行してください。",
  },
  "jobs.running": { en: "running", ja: "実行中" },
  "jobs.succeeded": { en: "succeeded", ja: "成功" },
  "jobs.failed": { en: "failed", ja: "失敗" },
  "jobs.ui": { en: "UI", ja: "UI" },
  "jobs.upstream": { en: "upstream", ja: "上流" },
  "jobs.prompt": { en: "prompt {id}", ja: "prompt {id}" },
  "jobs.interrupted": { en: "interrupted by a restart", ja: "再起動で中断されました" },
  "jobs.delete": { en: "Delete", ja: "削除" },

  // Upload ------------------------------------------------------------------
  "upload.title": { en: "Upload", ja: "アップロード" },
  "upload.reload": { en: "Reload from disk", ja: "ディスクから再読み込み" },
  "upload.file": { en: "API-format workflow (.json)", ja: "API 形式のワークフロー (.json)" },
  "upload.name": { en: "Save as (optional)", ja: "保存名（任意）" },
  "upload.namePlaceholder": { en: "the file's own name", ja: "ファイル名のまま" },
  "upload.submit": { en: "Upload", ja: "アップロード" },
  "upload.pickFile": { en: "choose a .json file", ja: ".json ファイルを選んでください" },
  "upload.uploading": { en: "uploading…", ja: "アップロード中…" },
  "upload.saved": { en: "saved as {name}", ja: "{name} として保存しました" },
  "upload.reloaded": { en: "reloaded from disk", ja: "ディスクから読み直しました" },

  // Installed workflows -----------------------------------------------------
  "workflows.title": { en: "Installed", ja: "インストール済み" },
  "workflows.dir": { en: "Files live in {dir}", ja: "保存先は {dir} です" },
  "workflows.empty": {
    en: "Nothing installed yet. Export one from ComfyUI with <strong>Workflow → Export (API)</strong> and upload it above.",
    ja: "まだ何もありません。ComfyUI の <strong>Workflow → Export (API)</strong> で書き出して、上からアップロードしてください。",
  },
  "workflows.active": { en: "active", ja: "使用中" },
  "workflows.makeActive": { en: "Make active", ja: "これを使う" },
  "workflows.delete": { en: "Delete", ja: "削除" },
  "workflows.deleteConfirm": {
    en: 'Delete "{name}"? The file is removed from disk.',
    ja: "「{name}」を削除しますか？ディスクからファイルも消えます。",
  },
  "workflows.deleteFailed": { en: "delete failed", ja: "削除できませんでした" },
  "workflows.nodes": { en: "{count} nodes", ja: "ノード {count} 個" },

  "slot.detected": { en: "detected", ja: "自動検出" },
  "slot.override": { en: "from .slots.json", ja: ".slots.json での指定" },
  "slot.missing": { en: "not found", ja: "見つかりません" },

  // ComfyUI itself ----------------------------------------------------------
  "comfy.title": { en: "ComfyUI", ja: "ComfyUI" },
  "comfy.dir": { en: "Directory", ja: "ディレクトリ" },
  "comfy.command": { en: "Start command (optional)", ja: "起動コマンド（任意）" },
  "comfy.commandPlaceholder": {
    en: "detected from the directory",
    ja: "ディレクトリから自動で判定",
  },
  "comfy.save": { en: "Save", ja: "保存" },
  "comfy.saving": { en: "saving…", ja: "保存中…" },
  "comfy.saved": { en: "saved", ja: "保存しました" },
  "comfy.saveFailed": { en: "save failed", ja: "保存できませんでした" },
  "comfy.warning": {
    en: "Starting ComfyUI runs this command on this machine. Anyone who can reach this page can trigger it, which is why the UI listens on 127.0.0.1 unless you change <code>UI_HOSTNAME</code>.",
    ja: "起動するとこのマシンでこのコマンドが実行されます。このページを開ける人は誰でも実行できるため、<code>UI_HOSTNAME</code> を変えない限り UI は 127.0.0.1 だけで待ち受けます。",
  },

  "comfy.start": { en: "Start ComfyUI", ja: "ComfyUI を起動" },
  "comfy.stop": { en: "Stop ComfyUI", ja: "ComfyUI を停止" },
  "comfy.needsDir": {
    en: "set the ComfyUI directory on the Settings page first",
    ja: "先に設定ページで ComfyUI のディレクトリを指定してください",
  },

  "process.title": { en: "Process", ja: "プロセス" },
  "process.start": { en: "Start", ja: "起動" },
  "process.stop": { en: "Stop", ja: "停止" },
  "process.failed": { en: "failed", ja: "失敗しました" },
  "process.noDir": {
    en: "No ComfyUI directory set. Fill it in above.",
    ja: "ComfyUI のディレクトリが未設定です。上の欄に入力してください。",
  },
  "process.startedAt": { en: "started {time} · pid {pid}", ja: "{time} に起動 · pid {pid}" },
  "process.foreign": { en: "not started from here", ja: "ここからは起動していません" },

  // Upstream servers --------------------------------------------------------
  "servers.title": { en: "Upstream servers", ja: "上流サーバー" },
  "servers.add": { en: "Add server", ja: "サーバーを追加" },
  "servers.help": {
    en: "Asked for work from the top down. The first server with something queued gets this machine, so the order is the priority.",
    ja: "上から順に問い合わせます。仕事を持っていた最初のサーバーがこのマシンを使うので、並び順がそのまま優先順位です。",
  },
  "servers.empty": {
    en: "No upstream servers. This machine runs whatever you queue here and nothing else.",
    ja: "上流サーバーはありません。このマシンはここで入れた分だけを実行します。",
  },
  "servers.save": { en: "Save servers", ja: "サーバー設定を保存" },
  "servers.revert": { en: "Revert", ja: "元に戻す" },
  "servers.saving": { en: "saving…", ja: "保存中…" },
  "servers.saved": {
    en: "saved — the agent picked it up",
    ja: "保存しました。エージェントに反映済みです",
  },
  "servers.saveFailed": { en: "save failed", ja: "保存できませんでした" },
  "servers.name": { en: "Name", ja: "名前" },
  "servers.url": { en: "URL", ja: "URL" },
  "servers.hostId": { en: "Host id", ja: "ホスト ID" },
  "servers.secret": { en: "Secret", ja: "シークレット" },
  "servers.secretUnchanged": { en: "unchanged", ja: "変更しない" },
  "servers.secretRequired": { en: "required", ja: "必須" },
  "servers.enabled": {
    en: "Claim jobs from this server",
    ja: "このサーバーの仕事を受け取る",
  },
  "servers.higher": { en: "Higher priority", ja: "優先順位を上げる" },
  "servers.lower": { en: "Lower priority", ja: "優先順位を下げる" },
  "servers.remove": { en: "Remove", ja: "削除" },
  "servers.notStarted": { en: "not started", ja: "未接続" },
  "servers.waiting": { en: "waiting", ja: "接続待ち" },
  "servers.up": { en: "up", ja: "応答あり" },
  "servers.down": { en: "down", ja: "応答なし" },
  "servers.queued": { en: "{count} waiting", ja: "待ち {count} 件" },
  "servers.test": { en: "Test", ja: "接続テスト" },
  "servers.testing": { en: "testing…", ja: "テスト中…" },
  "servers.testOk": { en: "answered in {ms} ms", ja: "{ms} ms で応答しました" },
  "servers.testFailed": { en: "no answer — {error}", ja: "応答なし — {error}" },

  // Durations ---------------------------------------------------------------
  "time.seconds": { en: "{seconds}s", ja: "{seconds}秒" },
  "time.minutes": { en: "{minutes}m {seconds}s", ja: "{minutes}分{seconds}秒" },

  /** Appended by CSS to a field the chosen workflow has no slot for. */
  "field.unused": { en: "unused", ja: "未使用" },
} satisfies Record<string, Entry>;

export type Key = keyof typeof STRINGS;

const DEFAULT_LANG: Lang = LANGS[0].code;
const STORAGE_KEY = "lang";

function isLang(value: unknown): value is Lang {
  return LANGS.some((entry) => entry.code === value);
}

function remembered(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isLang(stored) ? stored : DEFAULT_LANG;
  } catch {
    // Private mode — the default, and the choice lasts for this tab only.
    return DEFAULT_LANG;
  }
}

let current: Lang = remembered();

export function lang(): Lang {
  return current;
}

/** `{name}` in the string is replaced by `values.name`. */
export function t(key: Key, values?: Record<string, string | number>): string {
  const text: string = STRINGS[key][current];
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}

/** The locale to hand to `toLocaleTimeString` and friends. */
export function locale(): string {
  return LANGS.find((entry) => entry.code === current)?.locale ?? LANGS[0].locale;
}

const ATTRIBUTES: [attribute: string, target: string][] = [
  ["data-i18n-placeholder", "placeholder"],
  ["data-i18n-title", "title"],
  ["data-i18n-label", "aria-label"],
];

/**
 * Translate the static markup. `data-i18n-html` is allowed to carry tags
 * because the text comes from the table above, never from a request.
 */
export function translateDom(root: ParentNode = document): void {
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    node.textContent = t(node.dataset["i18n"] as Key);
  }
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n-html]")) {
    node.innerHTML = t(node.dataset["i18nHtml"] as Key);
  }
  for (const [attribute, target] of ATTRIBUTES) {
    for (const node of root.querySelectorAll<HTMLElement>(`[${attribute}]`)) {
      node.setAttribute(target, t(node.getAttribute(attribute) as Key));
    }
  }
}

const listeners: (() => void)[] = [];

/** Called after the language changed, for the parts drawn from state. */
export function onLangChange(listener: () => void): void {
  listeners.push(listener);
}

export function setLang(next: Lang): void {
  current = next;
  document.documentElement.lang = next;

  // The one label CSS writes rather than the DOM, because it is generated
  // content. Set here so it needs no rule of its own per language.
  document.documentElement.style.setProperty("--label-unused", `" · ${t("field.unused")}"`);

  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Private mode — the choice simply will not survive a reload.
  }

  translateDom();
  for (const listener of listeners) listener();
}
