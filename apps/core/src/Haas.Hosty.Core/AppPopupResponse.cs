using System.Security.Cryptography;
using System.Text.Json;

namespace Haas.Hosty.Core;

// A Core-owned top-level popup talks only to the requesting app, never its embedder.
internal static class AppPopupResponse
{
    private static string Js(string value) => "\"" + JsonEncodedText.Encode(value).ToString() + "\"";

    internal static IResult Render(HttpResponse response, string redirectUri, string state, string code)
    {
        var origin = new Uri(redirectUri).GetLeftPart(UriPartial.Authority);
        var nonce = Convert.ToBase64String(RandomNumberGenerator.GetBytes(24));
        response.Headers.CacheControl = "no-store";
        response.Headers["Content-Security-Policy"] = $"default-src 'none'; script-src 'nonce-{nonce}'; frame-ancestors 'none'; base-uri 'none'";
        response.Headers["X-Frame-Options"] = "DENY";
        response.Headers["X-Content-Type-Options"] = "nosniff";
        response.Headers["Referrer-Policy"] = "no-referrer";
        // The cross-origin opener is deliberately retained for this one app-bound response.
        response.Headers["Cross-Origin-Opener-Policy"] = "unsafe-none";
        return Results.Content($$"""
            <!doctype html><html lang="en"><meta charset="utf-8"><title>Hosty sign-in</title>
            <p id="status">Completing sign-in. You can close this window.</p>
            <script nonce="{{nonce}}">
            if (window.opener) {
              window.opener.postMessage({type:"hosty:app-auth-code",state:{{Js(state)}},code:{{Js(code)}}},{{Js(origin)}});
              window.close();
            } else {
              document.getElementById("status").textContent="The requesting window is unavailable. Return to the app and try signing in again.";
            }
            </script></html>
            """, "text/html");
    }
}
