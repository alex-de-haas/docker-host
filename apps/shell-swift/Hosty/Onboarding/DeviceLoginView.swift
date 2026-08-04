import HostyKit
import SwiftUI

#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Signing in by approving a code in a real browser.
///
/// The reason this exists rather than the web view: a `WKWebView` embedded in a third-party app gets no
/// AutoFill — not iCloud Keychain, not a password manager, not a passkey. AutoFill in web pages belongs
/// to Safari, not to WebKit's public API, so the credential the operator has already saved for this host
/// is unreachable from inside this app. Handing the sign-in to the browser that owns it is the whole
/// point; what comes back is an access token, collected over Core's device authorization flow.
struct DeviceLoginView: View {
    let origin: HostOrigin
    let onSession: (String) -> Void
    /// Offered whenever this flow cannot finish here — an older host, no Shell to approve in, a denial.
    let onUsePasswordForm: () -> Void

    @State private var label = DeviceName.current
    @State private var stage: Stage = .naming
    @Environment(\.openURL) private var openURL

    private enum Stage: Equatable {
        /// Before anything is requested: the label is still the operator's to change.
        case naming
        case requesting
        case waiting(DeviceAuthorization, expiresAt: Date)
        case denied
        case expired
        case failed(String)
    }

    var body: some View {
        Form {
            switch stage {
            case .naming:
                naming
            case .requesting:
                Section { ProgressView("Asking \(origin.displayName) for a code…") }
            case .waiting(let authorization, let expiresAt):
                waiting(authorization, expiresAt: expiresAt)
            case .denied:
                outcome(
                    title: "Request denied",
                    message: "Someone signed in to \(origin.displayName) declined this request.",
                    icon: "hand.raised")
            case .expired:
                outcome(
                    title: "Request expired",
                    message: "Nobody approved the code in time. Ask for a new one.",
                    icon: "clock.badge.exclamationmark")
            case .failed(let message):
                outcome(title: "Could not ask for a code", message: message, icon: "exclamationmark.triangle")
            }
        }
        .formStyle(.grouped)
        // Tied to the view rather than started from the button, so closing the sheet cancels the poll.
        // A loop owned by a detached task would go on presenting a device code for its full ten minutes
        // after the screen that showed it is gone.
        .task(id: pendingDeviceCode) { await pollForApproval() }
    }

    // MARK: - Stages

    @ViewBuilder
    private var naming: some View {
        Section {
            TextField("Device name", text: $label, prompt: Text("This device"))
                .autocorrectionDisabled()
        } header: {
            Text("Name this device")
        } footer: {
            // The label is the only thing the approving human sees about who is asking, and on iOS the
            // system name is a model name to an unentitled app — two phones in one household would be
            // the same word. Only their owner can tell them apart, so they get to.
            Text("Whoever approves the request sees this name.")
        }

        Section {
            Button("Get a code", systemImage: "key.horizontal") { Task { await requestCode() } }
                .buttonStyle(.borderedProminent)
                .disabled(label.trimmingCharacters(in: .whitespaces).isEmpty)
        } footer: {
            Text("Hosty shows a code, you approve it in your browser, and this device is signed in. Your password stays in the browser.")
        }
    }

    @ViewBuilder
    private func waiting(_ authorization: DeviceAuthorization, expiresAt: Date) -> some View {
        Section {
            Text(authorization.formattedUserCode)
                .font(.system(.largeTitle, design: .monospaced, weight: .semibold))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 8)
                .accessibilityLabel(Text(spelledOut(authorization.userCode)))
        } header: {
            Text("Your code")
        } footer: {
            // A live countdown without a timer of its own: SwiftUI redraws this text on its own schedule.
            // The range is clamped because a `Text(timerInterval:)` whose start is past its end traps,
            // and the poll that turns an elapsed request into `.expired` can be a few seconds behind it.
            Text("Expires in ") + Text(timerInterval: min(.now, expiresAt)...expiresAt, countsDown: true)
        }

        if let url = authorization.approvalURL {
            Section {
                Button("Approve in browser", systemImage: "safari") { openURL(url) }
                    .buttonStyle(.borderedProminent)
            } footer: {
                // Shown before it is opened: the address came from the host, and this is the last point
                // where a person can see where they are being sent.
                Text("Opens \(url.absoluteString)")
            }
        } else {
            Section {
                Label("This host has no Shell to approve the code in", systemImage: "questionmark.circle")
            } footer: {
                Text("Approve it from another client signed in to \(origin.displayName), or sign in with a password instead.")
            }
        }

        Section {
            HStack {
                ProgressView().controlSize(.small)
                Text("Waiting for approval…")
                    .foregroundStyle(.secondary)
            }
        }

        passwordFormSection
    }

    @ViewBuilder
    private func outcome(title: String, message: String, icon: String) -> some View {
        Section {
            Label(title, systemImage: icon)
                .font(.headline)
            Text(message)
                .foregroundStyle(.secondary)
        }

        Section {
            Button("Start over", systemImage: "arrow.clockwise") { stage = .naming }
                .buttonStyle(.borderedProminent)
        }

        passwordFormSection
    }

    private var passwordFormSection: some View {
        Section {
            Button("Sign in with a password instead", systemImage: "rectangle.and.pencil.and.ellipsis") {
                onUsePasswordForm()
            }
        }
    }

    // MARK: - The flow

    /// The request being waited on, and the identity of the polling task. Nil in every other stage, which
    /// is what stops the poll when the operator starts over.
    private var pendingDeviceCode: String? {
        if case .waiting(let authorization, _) = stage { return authorization.deviceCode }
        return nil
    }

    private func requestCode() async {
        stage = .requesting

        // A client of its own, with no credential: this is what a device with nothing to present calls.
        do {
            let authorization = try await CoreClient(origin: origin).requestDeviceCode(
                label: label.trimmingCharacters(in: .whitespaces))
            stage = .waiting(authorization, expiresAt: .now.addingTimeInterval(authorization.lifetime))
        } catch {
            stage = .failed(error.localizedDescription)
        }
    }

    private func pollForApproval() async {
        guard case .waiting(let authorization, _) = stage else { return }

        do {
            switch try await DeviceLoginPoller(
                client: CoreClient(origin: origin),
                authorization: authorization).run() {
            case .approved(let token):
                // Handed over before anything else happens: Core consumes an approved request on the
                // first poll that collects it, so this value exists exactly once.
                onSession(token)
            case .denied:
                stage = .denied
            case .expired:
                stage = .expired
            }
        } catch is CancellationError {
            // The sheet closed. Nothing to report to a screen that is gone.
        } catch {
            stage = .failed(error.localizedDescription)
        }
    }

    /// `ABCD-EFGH` read out as letters. VoiceOver says the run of characters as a word otherwise, which
    /// is exactly the thing that cannot be typed back into a browser.
    private func spelledOut(_ code: String) -> String {
        code.map(String.init).joined(separator: " ")
    }
}

/// What this device is called, as a starting point for the label.
enum DeviceName {
    static var current: String {
        #if os(macOS)
        Host.current().localizedName ?? "Mac"
        #else
        UIDevice.current.name
        #endif
    }
}
