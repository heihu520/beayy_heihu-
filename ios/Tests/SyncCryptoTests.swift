import XCTest

/// 对照电脑那边的测试向量（报告/方案_20261021_录音与存储.md，cargo test -p beayy-sync vectors）。对不上就是手机的实现错了
final class SyncCryptoTests: XCTestCase {
    func testVectors() throws {
        let (auth, wrap) = try SyncCrypto.derive(password: "correct horse battery", saltHex: "00112233445566778899aabbccddeeff")
        XCTAssertEqual(auth, "473f74ad88325ba0de55aa0ec6bf0cb2defccc416c116a96d871aa08b0fd8d63")
        XCTAssertEqual(SyncCrypto.hex(wrap), "4f6e07861130fecfb9913ec06091a2cc29fbda63ac2c50b5e98a3c49537321ad")

        let key = try SyncCrypto.unwrapKey("CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJub2uTlqZNkmxnSXcKnul8mPuJqeccvpQe7JYsiK95s0CNAqTfgMTp8r0rrn20uSI", wrap: wrap)
        XCTAssertEqual(key, Data(repeating: 0x42, count: 32))

        let blob = SyncCrypto.unhex("0909090909090909090909090909090909090909090909097d871ad150cfc9b955bc0788f513cc148f20ae9d41c9ae0976b81688e6039a6fd16b6453b9d92137712ee0ce25abe677f0fad20cc14709011bb5")!
        let plain = try SyncCrypto.open(key: key, device: "watch-1a2b3c4d", name: "audio.watch-20261021T010000Z", blob: blob)
        XCTAssertEqual(String(decoding: plain, as: UTF8.self), "{\"id\":\"watch-20261021T010000Z\"}\nhello")

        // AAD 不对（换了块名）就解不开
        XCTAssertThrowsError(try SyncCrypto.open(key: key, device: "watch-1a2b3c4d", name: "audio.other", blob: blob))
        // 主密码不对就解不开数据密钥
        XCTAssertThrowsError(try SyncCrypto.unwrapKey("CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJub2uTlqZNkmxnSXcKnul8mPuJqeccvpQe7JYsiK95s0CNAqTfgMTp8r0rrn20uSI",
                                                  wrap: Data(repeating: 1, count: 32)))
    }

    /// 手机封、手机拆（raw deflate 往返；大块像一段录音那么大）
    func testSealRoundTrip() throws {
        let key = Data(repeating: 7, count: 32)
        var plain = Data("{\"id\":\"watch-20261021T010000Z\"}\n".utf8)
        plain.append(Data((0..<4_000_000).map { UInt8(truncatingIfNeeded: $0 &* 2654435761 >> 13) }))
        let blob = try SyncCrypto.seal(key: key, device: "watch-1a2b3c4d", name: "audio.watch-20261021T010000Z", plain: plain)
        XCTAssertEqual(try SyncCrypto.open(key: key, device: "watch-1a2b3c4d", name: "audio.watch-20261021T010000Z", blob: blob), plain)
        XCTAssertEqual(try SyncCrypto.open(key: key, device: "a", name: "b", blob: SyncCrypto.seal(key: key, device: "a", name: "b", plain: Data())), Data())
    }
}
