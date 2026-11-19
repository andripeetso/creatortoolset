import XCTest
@testable import CreatorToolset

/// One account sign-in is enough: the sign-in buttons, a hosted server opened with the account's ticket (the server's
/// side is apps/captions/api/auth-account-ticket.test.ts), and a computers list that failed.
@MainActor
final class OneSignInTests: XCTestCase {
    // MARK: the sign-in buttons

    func testOnePressRunsAtATimeAndTheOthersIgnorePresses() {
        XCTAssertEqual(AccountSignInButtons.start("google", running: nil), "google")
        XCTAssertNil(AccountSignInButtons.start("github", running: "google"))
        XCTAssertNil(AccountSignInButtons.start("google", running: "google"))
    }

    // MARK: hosted servers through the account

    private func descriptor(_ json: String) throws -> ServerDescriptor {
        try JSONDecoder().decode(ServerDescriptor.self, from: Data(json.utf8))
    }

    func testOnlyAHostedServerThatSaysSoTakesTheAccount() throws {
        XCTAssertTrue(try descriptor(#"{"serverId":"s1","label":"studio.example.com","platform":"hosted","protocol":1,"capabilities":{"pairing":true,"dpop":true,"connect":false,"account":true}}"#).takesAccount)
        // a server from before tickets, one that names no sign-in service, and a computer
        XCTAssertFalse(try descriptor(#"{"serverId":"s1","label":"a","platform":"hosted","protocol":1,"capabilities":{"pairing":true,"dpop":true,"connect":false}}"#).takesAccount)
        XCTAssertFalse(try descriptor(#"{"serverId":"s1","label":"a","platform":"hosted","protocol":1,"capabilities":{"account":false}}"#).takesAccount)
        XCTAssertFalse(try descriptor(#"{"serverId":"s1","label":"a","platform":"hosted","protocol":1}"#).takesAccount)
        XCTAssertFalse(try descriptor(#"{"serverId":"s1","label":"a","platform":"mac","protocol":1,"capabilities":{"account":true}}"#).takesAccount)
    }

    func testTheTicketIsForTheHostAndItsPort() {
        XCTAssertEqual(AccountServers.host(URL(string: "https://Studio.Example.com/")!), "studio.example.com")
        XCTAssertEqual(AccountServers.host(URL(string: "https://studio.example.com:8443")!), "studio.example.com:8443")
    }

    func testTheTicketIsTradedWithItsVerifierAndThisPhonesKey() async throws {
        StubServer.reset()
        StubServer.answers["/oauth/token"] = (200, #"{"access_token":"cts_x","token_type":"DPoP","expires_in":3600,"scope":"read write access"}"#)
        let credential = try await Pairing.exchange(URL(string: "https://studio.example.com/")!, credential: "T1", dpop: true,
                                                    metadata: ["code_verifier": "v1"], tokenType: Pairing.accountTicketType,
                                                    session: StubServer.session)
        XCTAssertEqual(credential.kind, .dpop)
        let form = Dictionary(uniqueKeysWithValues: (StubServer.bodies["/oauth/token"] ?? "").split(separator: "&").map { pair -> (String, String) in
            let kv = pair.split(separator: "=", maxSplits: 1).map { String($0).removingPercentEncoding ?? "" }
            return (kv[0], kv.count > 1 ? kv[1] : "")
        })
        XCTAssertEqual(form["subject_token_type"], "urn:creatortoolset:params:oauth:token-type:account-ticket")
        XCTAssertEqual(form["subject_token"], "T1")
        XCTAssertEqual(form["code_verifier"], "v1")
    }

    // MARK: a computers list that failed

    func testAFailedListIsTriedAgainLaterEachTime() {
        XCTAssertEqual((1...7).map { AccountServers.backoff($0) }, [5, 15, 45, 120, 300, 300, 300])
        XCTAssertEqual(AccountServers.backoff(0), 5)
    }

    func testTheTraceSaysWhatTheServiceAnswered() {
        XCTAssertEqual(AccountServers.trace(APIError.server(404, "not_found")), "404 not_found")
        XCTAssertEqual(AccountServers.trace(AccountError.refused("Your account has no connect service yet")), "Your account has no connect service yet")
    }
}
