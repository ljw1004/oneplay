import MSAL
import UIKit

@main final class AppDelegate: UIResponder, UIApplicationDelegate {
    // The account and audio session live through a WebKit process replacement.
    lazy var library = LibraryController()
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene, let app = UIApplication.shared.delegate as? AppDelegate else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = app.library
        self.window = window
        window.makeKeyAndVisible()
        forwardCallback(connectionOptions.urlContexts)
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        (window?.rootViewController as? LibraryController)?.signalPendingDiagnostics()
    }

    func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) { forwardCallback(contexts) }

    /// Cold and warm launches deliver through the same scene lifecycle.
    private func forwardCallback(_ contexts: Set<UIOpenURLContext>) {
        for context in contexts where context.url.scheme == "msauth.\(Bundle.main.bundleIdentifier!)" && context.url.host == "auth" {
            MSALPublicClientApplication.handleMSALResponse(context.url, sourceApplication: context.options.sourceApplication)
        }
    }
}
