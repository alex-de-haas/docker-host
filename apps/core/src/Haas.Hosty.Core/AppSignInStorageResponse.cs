using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.WebUtilities;

namespace Haas.Hosty.Core;

// HTTP localhost cannot rely on Secure-cookie exceptions in every browser. Only the validated
// initiation POST writes this origin-isolated proof; a copied continuation URL can only read it.
internal static class AppSignInStorageResponse
{
    private const string StoragePrefix = "hosty.core.signin.";
    private static string Js(string value) => "\"" + JsonEncodedText.Encode(value).ToString() + "\"";

    internal static IResult RenderBootstrap(HttpResponse response, AppSignInIntentCreated created)
        => RenderBridge(response, created.Intent, created.Nonce);

    internal static IResult RenderContinuation(HttpResponse response, AppSignInIntent intent)
        => RenderBridge(response, intent, initialNonce: null);

    private static IResult RenderBridge(HttpResponse response, AppSignInIntent intent, string? initialNonce)
    {
        var scriptNonce = Protect(response, intent.Mode);
        var callback = QueryHelpers.AddQueryString(intent.RedirectUri, "error", "login_required");
        if (!QueryHelpers.ParseQuery(new Uri(callback).Query).ContainsKey("state"))
            callback = QueryHelpers.AddQueryString(callback, "state", intent.State);
        var action = $"/api/apps/{Uri.EscapeDataString(intent.AppId)}/open?requestId={intent.Id}";
        var origin = new Uri(intent.RedirectUri).GetLeftPart(UriPartial.Authority);
        return Results.Content($$"""
            <!doctype html><html lang="en"><meta charset="utf-8"><title>Hosty sign-in</title>
            <p id="status">Continuing sign-in.</p>
            <noscript>JavaScript is required for named-localhost sign-in. Return to the app and start again after enabling JavaScript.</noscript>
            <script nonce="{{scriptNonce}}">
            (() => {
              const prefix = {{Js(StoragePrefix)}};
              const requestId = {{Js(intent.Id)}};
              const initialNonce = {{(initialNonce is null ? "null" : Js(initialNonce))}};
              const key = prefix + requestId;
              const mode = {{Js(intent.Mode.ToString().ToLowerInvariant())}};
              function fail(code) {
                document.getElementById("status").textContent = code === "sign_in_intent_capacity"
                  ? "Too many pending sign-in attempts. Complete an existing attempt or wait five minutes."
                  : "This browser cannot continue the sign-in attempt. Return to the app and start sign-in again.";
                if (mode === "silent") { location.replace({{Js(callback)}}); }
                else if (mode === "popup" && window.opener) {
                  window.opener.postMessage({type:"hosty:app-auth-code",state:{{Js(intent.State)}},error:code},{{Js(origin)}});
                }
              }
              try {
                const keys = [];
                for (let i = 0; i < sessionStorage.length; i++) {
                  const name = sessionStorage.key(i);
                  if (name && name.startsWith(prefix)) keys.push(name);
                }
                const proofs = {};
                for (const name of keys) {
                  let record;
                  try { record = JSON.parse(sessionStorage.getItem(name)); } catch { record = null; }
                  const id = name.slice(prefix.length);
                  if (!/^[a-f0-9]{64}$/.test(id) || !record || !/^[a-f0-9]{64}$/.test(record.nonce)
                      || !Number.isFinite(record.expires) || record.expires <= Date.now()) {
                    sessionStorage.removeItem(name);
                  } else { proofs[id] = record.nonce; }
                }
                if (initialNonce !== null) {
                  if (Object.keys(proofs).length >= {{AppSignInIntentStore.MaxPerBrowser}}) {
                    fail("sign_in_intent_capacity"); return;
                  }
                  sessionStorage.setItem(key, JSON.stringify({nonce:initialNonce,expires:Date.now()+{{(long)AppSignInIntentStore.Lifetime.TotalMilliseconds}}}));
                  proofs[requestId] = initialNonce;
                }
                if (!proofs[requestId]) { fail("sign_in_intent_invalid"); return; }
                if (Object.keys(proofs).length > {{AppSignInIntentStore.MaxPerBrowser}}) {
                  fail("sign_in_intent_capacity"); return;
                }
                const form = document.createElement("form");
                form.method = "post";
                form.action = {{Js(action)}};
                for (const [name, value] of Object.entries({nonce:proofs[requestId],browserProofs:JSON.stringify(proofs)})) {
                  const input = document.createElement("input");
                  input.type = "hidden"; input.name = name; input.value = value;
                  form.appendChild(input);
                }
                document.body.appendChild(form);
                form.submit();
              } catch { fail("sign_in_storage_unavailable"); }
            })();
            </script></html>
            """, "text/html");
    }

    internal static IResult RenderRedirect(HttpResponse response, AppSignInIntent intent, string validatedLocation, bool terminal)
    {
        var scriptNonce = Protect(response, intent.Mode);
        return Results.Content($$"""
            <!doctype html><html lang="en"><meta charset="utf-8"><title>Hosty sign-in</title>
            <p>Continuing sign-in.</p>
            <script nonce="{{scriptNonce}}">
            {{(terminal ? Clear(intent) : "")}}
            const destination = {{Js(validatedLocation)}};
            location.replace(destination);
            </script></html>
            """, "text/html");
    }

    internal static IResult RenderPopup(HttpResponse response, AppSignInIntent intent, string field, string value, bool close)
    {
        var scriptNonce = Protect(response, intent.Mode);
        var origin = new Uri(intent.RedirectUri).GetLeftPart(UriPartial.Authority);
        return Results.Content($$"""
            <!doctype html><html lang="en"><meta charset="utf-8"><title>Hosty sign-in</title>
            <p id="status">Completing sign-in. You can close this window.</p>
            <script nonce="{{scriptNonce}}">
            {{Clear(intent)}}
            if (window.opener) {
              window.opener.postMessage({type:"hosty:app-auth-code",state:{{Js(intent.State)}},[{{Js(field)}}]:{{Js(value)}}},{{Js(origin)}});
              {{(close ? "window.close();" : "")}}
            } else {
              document.getElementById("status").textContent="The requesting window is unavailable. Return to the app and try signing in again.";
            }
            </script></html>
            """, "text/html");
    }

    internal static IResult RenderRefusal(HttpResponse response, AppSignInIntent intent, string message, int statusCode)
    {
        var scriptNonce = Protect(response, intent.Mode);
        return Results.Content($$"""
            <!doctype html><html lang="en"><meta charset="utf-8"><title>Hosty sign-in</title>
            <p>{{WebUtility.HtmlEncode(message)}}</p>
            <script nonce="{{scriptNonce}}">{{Clear(intent)}}</script></html>
            """, "text/html", statusCode: statusCode);
    }

    private static string Clear(AppSignInIntent intent)
        => $"try {{ sessionStorage.removeItem({Js(StoragePrefix + intent.Id)}); }} catch {{}}";

    private static string Protect(HttpResponse response, AppSignInMode mode)
    {
        var nonce = Convert.ToBase64String(RandomNumberGenerator.GetBytes(24));
        response.Headers.CacheControl = "no-store";
        response.Headers["Content-Security-Policy"] = $"default-src 'none'; script-src 'nonce-{nonce}'; form-action 'self'; base-uri 'none'"
            + (mode == AppSignInMode.Silent ? "" : "; frame-ancestors 'none'");
        if (mode == AppSignInMode.Silent) response.Headers.Remove("X-Frame-Options");
        else response.Headers["X-Frame-Options"] = "DENY";
        response.Headers["X-Content-Type-Options"] = "nosniff";
        // Native same-origin forms need their non-null Origin on the continuation POST.
        response.Headers["Referrer-Policy"] = "same-origin";
        response.Headers["Cross-Origin-Opener-Policy"] = "unsafe-none";
        return nonce;
    }
}
