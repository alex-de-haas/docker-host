import SwiftUI

@main
struct HostyApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
        #if os(macOS)
        .defaultSize(width: 900, height: 620)
        #endif
    }
}
