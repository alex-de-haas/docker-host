using System.Net;

namespace Haas.Hosty.Core;

// Core's trusted forms share local, framework-free presentation. Callers still own
// authentication, CSP and the exact fields/decisions in the reviewed form.
internal static class CoreBrowserPages
{
    public static void MapAssets(WebApplication app)
    {
        foreach (var name in new[] { "plex-sans-latin.woff2", "plex-sans-latin-ext.woff2",
            "plex-sans-cyrillic.woff2", "jetbrains-mono-latin.woff2",
            "jetbrains-mono-latin-ext.woff2", "jetbrains-mono-cyrillic.woff2" })
        {
            app.MapGet("/core-assets/" + name, (HttpResponse response) =>
            {
                response.Headers["X-Content-Type-Options"] = "nosniff";
                response.Headers.CacheControl = "public, max-age=3600";
                var resource = typeof(CoreBrowserPages).Assembly.GetManifestResourceStream($"Haas.Hosty.Core.Browser.{name}")
                    ?? throw new InvalidOperationException($"Missing Core font: {name}");
                return Results.Stream(resource, "font/woff2");
            });
        }
    }

    public const string Mark = """
        <svg class="hosty-mark" width="24" height="24" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
          <g fill="currentColor"><path d="M10 10h22v22H10z M10 39h22v22H10z M10 68h22v22H10z M68 10h22v22H68z M68 39h22v22H68z M68 68h22v22H68z"/>
          <path fill="#A3E635" d="M39 39h22v22H39z"/></g>
        </svg>
        """;

    public const string Brand = "<header class=\"core-brand\">" + Mark + "<span>Hosty Core</span></header>";

    public static string Approval(string title, string? name, string? version, string caller, string body)
    {
        static string E(string? value) => WebUtility.HtmlEncode(value ?? "");
        var versionLine = version is null ? "" : $"<p class=\"version\">{E(version)}</p>";
        return $$"""
            <!doctype html>
            <html lang="en">
            <head>
              <meta charset="utf-8">
              <meta name="viewport" content="width=device-width, initial-scale=1">
              <title>{{E(title)}} — Hosty Core</title>
              <style>{{CommonStyles}}{{ApprovalStyles}}</style>
            </head>
            <body class="approval-page">
              <div class="core-frame">
                {{Brand}}
                <main>
                  <header class="review-header">
                    <p class="eyebrow">{{E(title)}}</p>
                    <h1>{{E(name ?? title)}}</h1>
                    {{versionLine}}
                    <p class="requester">Requested by {{E(caller)}}</p>
                  </header>
                  <div class="review-body">{{body}}</div>
                </main>
              </div>
            </body>
            </html>
            """;
    }

    public const string CommonStyles = """
        @font-face {
          font-family: 'IBM Plex Sans';
          font-style: normal;
          font-weight: 100 900;
          font-stretch: 100%;
          font-display: swap;
          src: url("/core-assets/plex-sans-latin.woff2") format('woff2');
          unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
        }
        @font-face {
          font-family: 'IBM Plex Sans';
          font-style: normal;
          font-weight: 100 900;
          font-stretch: 100%;
          font-display: swap;
          src: url("/core-assets/plex-sans-latin-ext.woff2") format('woff2');
          unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF;
        }
        @font-face {
          font-family: 'IBM Plex Sans';
          font-style: normal;
          font-weight: 100 900;
          font-stretch: 100%;
          font-display: swap;
          src: url("/core-assets/plex-sans-cyrillic.woff2") format('woff2');
          unicode-range: U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;
        }
        @font-face {
          font-family: 'JetBrains Mono';
          font-style: normal;
          font-weight: 100 800;
          font-display: swap;
          src: url("/core-assets/jetbrains-mono-latin.woff2") format('woff2');
          unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
        }
        @font-face {
          font-family: 'JetBrains Mono';
          font-style: normal;
          font-weight: 100 800;
          font-display: swap;
          src: url("/core-assets/jetbrains-mono-latin-ext.woff2") format('woff2');
          unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF;
        }
        @font-face {
          font-family: 'JetBrains Mono';
          font-style: normal;
          font-weight: 100 800;
          font-display: swap;
          src: url("/core-assets/jetbrains-mono-cyrillic.woff2") format('woff2');
          unicode-range: U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;
        }
        :root {
          color-scheme: light dark;
          --canvas: #F6F8FB; --surface: #FFFFFF; --text: #0F1B2D; --secondary: #3A4B66;
          --muted: #5A6A82; --line: #DFE5EE; --soft-line: #EEF2F7; --field-line: #93A3BA;
          --action: #0F1B2D; --action-text: #FFFFFF; --lime: #A3E635; --lime-soft: #ECFCCB;
          --link: #1449C2; --danger: #B4232A; --danger-soft: #FDECEC;
          --warning: #8A5300; --warning-soft: #FEF3DC; --success: #0F6B33; --success-soft: #E8F7EE;
          --sans: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
          --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Consolas, monospace;
        }
        @media (prefers-color-scheme: dark) {
          :root {
            --canvas: #0F1B2D; --surface: #17253B; --text: #F6F8FB; --secondary: #C3CDDB;
            --muted: #93A3BA; --line: #3A4B66; --soft-line: #26364F; --field-line: #6E7F98;
            --action: #F6F8FB; --action-text: #0F1B2D; --lime-soft: #273B2E;
            --link: #8DB4FF; --danger: #FF8A8E; --danger-soft: #3F2532;
            --warning: #F8CA75; --warning-soft: #382F24; --success: #86EFAC; --success-soft: #183A32;
          }
        }
        *, *::before, *::after { box-sizing: border-box; }
        body { margin: 0; background: var(--canvas); color: var(--text); font: 14px/1.55 var(--sans); }
        ::selection { background: var(--lime); color: #0F1B2D; }
        h1 { margin: 0; font-size: 26px; line-height: 1.25; letter-spacing: -.02em; font-weight: 600; overflow-wrap: anywhere; }
        h2, legend { font-size: 15px; font-weight: 600; }
        p { margin: 12px 0; }
        a { color: var(--link); text-underline-offset: 3px; }
        code, .version { font: 12px/1.6 var(--mono); overflow-wrap: anywhere; }
        code { color: var(--muted); }
        input, select, button { font: inherit; color: inherit; }
        input:not([type=checkbox]):not([type=hidden]), select {
          min-height: 42px; max-width: 100%; padding: 9px 12px;
          border: 1px solid var(--field-line); border-radius: 9px; background: var(--surface);
        }
        input[type=checkbox] { width: 18px; height: 18px; margin: 3px 8px 3px 0; accent-color: var(--lime); vertical-align: middle; flex: none; }
        button {
          min-height: 42px; padding: 9px 16px; border: 1px solid var(--line); border-radius: 9px;
          background: var(--surface); font-weight: 500; cursor: pointer; line-height: 1.4;
        }
        button.primary { background: var(--action); color: var(--action-text); border-color: var(--action); }
        button.danger { background: var(--danger); color: var(--surface); border-color: var(--danger); }
        button:not(:disabled):hover { background: var(--lime-soft); color: var(--text); }
        button.primary:not(:disabled):hover, button.primary:not(:disabled):active { background: var(--lime); color: #0F1B2D; border-color: #5A9A0A; }
        button.danger:not(:disabled):hover { background: var(--danger-soft); color: var(--danger); border-color: var(--danger); }
        button:disabled { opacity: .5; cursor: not-allowed; }
        :is(button, input, select, a, summary):focus-visible {
          outline: 3px solid var(--lime); outline-offset: 2px; box-shadow: 0 0 0 2px var(--text);
        }
        .core-brand { display: flex; align-items: center; gap: 10px; font-size: 15px; font-weight: 600; }
        .hosty-mark { flex: none; }
        main { background: var(--surface); border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 4px 14px -4px rgb(15 27 45 / 10%); }
        .muted, .source, .requester { color: var(--muted); font-size: 13px; }
        .source { overflow-wrap: anywhere; }
        .warning, .error { padding: 12px 14px; border-radius: 10px; overflow-wrap: anywhere; }
        .warning { background: var(--warning-soft); color: var(--warning); border: 1px solid var(--warning); }
        .error { background: var(--danger-soft); color: var(--danger); border: 1px solid var(--danger); }
        .warning code, .error code { color: inherit; }
        @media (max-width: 520px) {
          h1 { font-size: 23px; }
          input:not([type=checkbox]), select { font-size: 16px; }
          button { min-height: 44px; }
        }
        @media (forced-colors: active) {
          button, input, select, main, fieldset { border: 1px solid ButtonText; }
          :is(button, input, select, a, summary):focus-visible { outline: 3px solid Highlight; }
        }
        """;

    public const string AuthenticationStyles = CommonStyles + """
        body { min-height: 100vh; min-height: 100svh; padding: 32px 16px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 20px; }
        body > .core-brand { width: min(420px, 100%); }
        main { width: min(420px, 100%); padding: 28px; }
        h1 { margin-bottom: 24px; }
        form { display: grid; gap: 18px; margin: 20px 0 0; }
        .field { display: grid; gap: 6px; }
        label { font-size: 13px; font-weight: 500; }
        input, select, button { width: 100%; }
        form button { margin-top: 4px; background: var(--action); color: var(--action-text); border-color: var(--action); }
        form button:not(:disabled):hover { background: var(--lime); color: #0F1B2D; border-color: #5A9A0A; }
        .meta { margin-top: 24px; padding-top: 18px; border-top: 1px solid var(--soft-line); font-size: 13px; color: var(--muted); }
        .meta p { margin: 4px 0; overflow-wrap: anywhere; }
        #message:empty { display: none; }
        @media (max-width: 520px) { main { padding: 24px 20px; } }
        """;

    private const string ApprovalStyles = """
        body { padding: 24px; }
        .core-frame { width: min(712px, 100%); margin: 0 auto; }
        .core-brand { margin: 0 4px 18px; }
        .review-header { padding: 24px 28px 20px; border-bottom: 1px solid var(--soft-line); }
        .eyebrow { margin: 0 0 12px; color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
        .version { margin: 6px 0 0; color: var(--secondary); }
        .requester { margin: 14px 0 0; }
        .review-body { padding: 8px 28px 0; overflow-wrap: anywhere; }
        .review-body > :last-child:not(form) { margin-bottom: 24px; }
        h2 { margin: 22px 0 8px; padding-top: 18px; border-top: 1px solid var(--soft-line); }
        ul { margin: 8px 0 18px; padding-left: 20px; }
        li { margin: 10px 0; padding-left: 2px; }
        li code { display: inline-block; }
        .permission-list { list-style: none; padding: 0; }
        .permission-list li { padding: 8px 0; }
        .permission-list code, .permission-choice code { display: block; margin-top: 3px; }
        .permission-choice label { display: flex; align-items: start; gap: 12px; padding: 6px 0; }
        .permission-choice label > span { flex: 1; min-width: 0; }
        .permission-choice input { order: 2; margin: 3px 0 0; }
        .review-body > h2:first-child { border-top: 0; padding-top: 0; }
        dl { display: grid; grid-template-columns: 100px minmax(0, 1fr); gap: 10px 16px; margin: 20px 0; }
        dt { color: var(--muted); } dd { margin: 0; }
        fieldset { min-width: 0; padding: 16px 0 4px; margin: 22px 0 0; border: 0; border-top: 1px solid var(--soft-line); }
        legend { padding: 0 10px 0 0; }
        fieldset p { margin: 10px 0; }
        fieldset label { cursor: pointer; }
        select { margin: 4px 8px 4px 0; }
        details { margin: 20px 0; } summary { cursor: pointer; font-weight: 500; }
        .actions {
          display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px;
          margin: 24px -28px 0; padding: 16px 28px; border-top: 1px solid var(--soft-line);
          background: var(--canvas); border-radius: 0 0 16px 16px;
        }
        .outcome { margin: 24px 0; }
        .outcome h2 { padding: 0; border: 0; margin: 14px 0 8px; font-size: 20px; }
        .outcome-icon { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 12px; font-size: 24px; font-weight: 500; background: var(--soft-line); }
        .outcome[data-state=succeeded] .outcome-icon { background: var(--success-soft); color: var(--success); }
        .outcome[data-state=failed] .outcome-icon { background: var(--danger-soft); color: var(--danger); }
        .outcome[data-state=executing] .outcome-icon { color: var(--link); }
        @media (max-width: 520px) {
          body { padding: 16px 12px; }
          .review-header { padding: 22px 20px 18px; }
          .review-body { padding: 8px 20px 0; }
          .actions { margin-left: -20px; margin-right: -20px; padding: 16px 20px; }
          .actions button { flex: 1; }
          dl { grid-template-columns: 80px minmax(0, 1fr); gap: 8px; }
        }
        """;
}
