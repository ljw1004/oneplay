import MSAL
import UIKit

/// Home identity and access token travel together inside Swift. The library never receives either credential.
struct IdentityGrant {
    let homeID: String
    let accessToken: String
    var expiresOn: Date? = nil
}

/// The Keychain boundary. The account coordinator can validate binding and interrupted logout without a live Microsoft account.
@MainActor protocol NativeIdentity {
    func acquireSilent(home: String, force: Bool) async throws -> IdentityGrant
    func acquireInteractive(home: String?, presenting: UIViewController) async throws -> IdentityGrant
    func cancelInteractive()
    func removePrivateAccounts() throws
}

@MainActor final class EntraIdentity: NativeIdentity {
    private let client: MSALPublicClientApplication
    private let scopes = ["Files.Read", "Files.ReadWrite.AppFolder"]

    init() throws {
        let authority = try MSALAADAuthority(url: URL(string: "https://login.microsoftonline.com/consumers")!)
        let bundleID = Bundle.main.bundleIdentifier!
        let config = MSALPublicClientApplicationConfig(clientId: "e4adae2b-3cf8-4ce8-b59f-d341b3bacbf6",
                                                       redirectUri: "msauth.\(bundleID)://auth", authority: authority)
        // This private group is documented in MSALCacheConfig.h and provisionable on a Personal Team.
        config.cacheConfig.keychainSharingGroup = bundleID
        MSALGlobalConfig.brokerAvailability = .none
        client = try MSALPublicClientApplication(configuration: config)
    }

    func acquireSilent(home: String, force: Bool) async throws -> IdentityGrant {
        guard let account = try client.allAccounts().first(where: { $0.homeAccountId?.identifier == home }) else {
            throw NativeAccountError.interactionRequired
        }
        let parameters = MSALSilentTokenParameters(scopes: scopes, account: account)
        parameters.forceRefresh = force
        let result = try await client.acquireTokenSilent(with: parameters)
        guard result.account.homeAccountId?.identifier == home else { throw NativeAccountError.wrongAccount }
        return IdentityGrant(homeID: home, accessToken: result.accessToken, expiresOn: result.expiresOn)
    }

    func acquireInteractive(home: String?, presenting presenter: UIViewController) async throws -> IdentityGrant {
        let web = MSALWebviewParameters(authPresentationViewController: presenter)
        web.webviewType = .authenticationSession
        let parameters = MSALInteractiveTokenParameters(scopes: scopes, webviewParameters: web)
        if let home {
            parameters.account = try client.allAccounts().first { $0.homeAccountId?.identifier == home }
        } else {
            // Local sign-out preserves the system browser's cookies. Let a fresh pairing choose a different account.
            parameters.promptType = .selectAccount
        }
        let result = try await client.acquireToken(with: parameters)
        guard let actual = result.account.homeAccountId?.identifier, !actual.isEmpty else { throw NativeAccountError.unavailable }
        guard home == nil || actual == home else {
            try client.remove(result.account)
            throw NativeAccountError.wrongAccount
        }
        return IdentityGrant(homeID: actual, accessToken: result.accessToken, expiresOn: result.expiresOn)
    }

    func cancelInteractive() { MSALPublicClientApplication.cancelCurrentWebAuthSession() }

    /// Even a process killed between interactive auth and binding can leave a credential in this app's private group.
    func removePrivateAccounts() throws {
        for account in try client.allAccounts() { try client.remove(account) }
    }
}
