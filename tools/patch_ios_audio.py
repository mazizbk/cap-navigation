"""Fait passer la voix de Cap par le Bluetooth de la voiture.

Problème : le module de reconnaissance vocale met l'iPhone en mode
« micro + haut-parleur du téléphone » et ne le remet jamais en mode normal.
Après une commande vocale, la voix sortait donc du téléphone, pas de la voiture.

Correctifs (lancés depuis ios-app/, après `npx cap add ios`) :
1. Au démarrage de l'appli : mode « lecture » (sort sur le Bluetooth, ne coupe pas la musique).
2. Pendant l'écoute : le son peut rester sur le Bluetooth de la voiture.
3. Après l'écoute : retour au mode « lecture ».
"""
import pathlib
import sys

RESTORE = (
    "try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.mixWithOthers]); "
    "try? AVAudioSession.sharedInstance().setActive(true)"
)


def patch(path, pairs):
    p = pathlib.Path(path)
    s = p.read_text(encoding="utf-8")
    for old, new, count in pairs:
        n = s.count(old)
        if n != count:
            sys.exit(f"{path}: attendu {count}x « {old[:60]} », trouvé {n}x")
        s = s.replace(old, new)
    p.write_text(s, encoding="utf-8")
    print("corrigé :", path)


# 1. Module de reconnaissance vocale
patch("node_modules/@capacitor-community/speech-recognition/ios/Plugin/Plugin.swift", [
    ("options: AVAudioSession.CategoryOptions.defaultToSpeaker)",
     "options: [.defaultToSpeaker, .allowBluetoothA2DP])", 1),
    ('self.notifyListeners("listeningState", data: ["status": "stopped"])',
     'self.notifyListeners("listeningState", data: ["status": "stopped"]); self.capRestoreAudio()', 3),
    ("    @objc func isListening(",
     "    func capRestoreAudio() {\n"
     "        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { " + RESTORE + " }\n"
     "    }\n\n"
     "    @objc func isListening(", 1),
])

# 2. Voiture garée automatiquement, sans raccourci à créer.
# Quand le Bluetooth de la voiture est branché, Cap suit le GPS en arrière-plan ;
# à la déconnexion, il garde la dernière position. Elle est transmise à la page
# (capnav://garee?…&quiet=1) dès que Cap est au premier plan.
CARWATCH = r'''

// MARK: - Cap : voiture garée automatiquement
final class CarWatch: NSObject, CLLocationManagerDelegate {
    static let shared = CarWatch()
    private let lm = CLLocationManager()
    private let ud = UserDefaults.standard
    private var inCar = false
    private var tracking = false
    private var lastFix: CLLocation?

    func start() {
        lm.delegate = self
        lm.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        lm.distanceFilter = 15
        NotificationCenter.default.addObserver(self, selector: #selector(routeChanged), name: AVAudioSession.routeChangeNotification, object: nil)
        authorize()
        check()
    }

    private func authorize() {
        switch CLLocationManager.authorizationStatus() {
        case .authorizedAlways: lm.startMonitoringSignificantLocationChanges()
        case .authorizedWhenInUse: lm.requestAlwaysAuthorization()
        default: break
        }
    }

    func locationManager(_ manager: CLLocationManager, didChangeAuthorization status: CLAuthorizationStatus) { authorize() }

    @objc private func routeChanged() { DispatchQueue.main.async { self.check() } }

    private func carPort() -> AVAudioSessionPortDescription? {
        let types: [AVAudioSession.Port] = [.carAudio, .bluetoothA2DP, .bluetoothHFP, .bluetoothLE]
        return AVAudioSession.sharedInstance().currentRoute.outputs.first { types.contains($0.portType) }
    }

    // La voiture : CarPlay, l'appareil déjà reconnu, ou un nom de voiture (jamais des écouteurs).
    private func isCar(_ p: AVAudioSessionPortDescription) -> Bool {
        if p.portType == .carAudio { return true }
        if let known = ud.string(forKey: "capCarUID") { return p.uid == known }
        let n = p.portName.lowercased()
        let notCar = ["airpods", "buds", "beats", "casque", "headphone", "écouteur", "speaker", "enceinte", "watch", "jbl", "bose", "sony"]
        if notCar.contains(where: { n.contains($0) }) { return false }
        let car = ["audi", "mmi", "car", "auto", "voiture", "vw", "volkswagen", "peugeot", "renault", "citroen", "bmw", "mercedes", "toyota", "skoda", "seat", "ford", "opel", "kia", "hyundai", "tesla"]
        return car.contains(where: { n.contains($0) })
    }

    func check() {
        if let p = carPort(), isCar(p) {
            if !inCar {
                inCar = true
                ud.set(p.uid, forKey: "capCarUID")
                startTracking()
            }
        } else if inCar {
            inCar = false
            park()
        }
    }

    private func startTracking() {
        let st = CLLocationManager.authorizationStatus()
        guard !tracking, st == .authorizedAlways || st == .authorizedWhenInUse else { return }
        tracking = true
        lm.allowsBackgroundLocationUpdates = true
        lm.pausesLocationUpdatesAutomatically = false
        lm.showsBackgroundLocationIndicator = false
        lm.startUpdatingLocation()
    }

    private func stopTracking() {
        guard tracking else { return }
        tracking = false
        lm.stopUpdatingLocation()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        if let l = locations.last, l.horizontalAccuracy >= 0, l.horizontalAccuracy < 100 { lastFix = l }
        check()
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}

    private func park() {
        let fix = lastFix ?? lm.location
        stopTracking()
        lastFix = nil
        guard let f = fix, Date().timeIntervalSince(f.timestamp) < 300 else { return }
        ud.set(["lat": f.coordinate.latitude, "lon": f.coordinate.longitude, "t": Date().timeIntervalSince1970 * 1000], forKey: "capPendingPark")
        if UIApplication.shared.applicationState == .active { flush() }
    }

    // Transmet la place notée à la page de Cap.
    func flush() {
        guard let p = ud.dictionary(forKey: "capPendingPark"),
              let lat = p["lat"] as? Double, let lon = p["lon"] as? Double, let t = p["t"] as? Double else { return }
        ud.removeObject(forKey: "capPendingPark")
        guard let url = URL(string: String(format: "capnav://garee?lat=%.6f&lon=%.6f&t=%.0f&quiet=1", lat, lon, t)) else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
        }
    }
}
'''

# 3. Démarrage de l'application
patch("ios/App/App/AppDelegate.swift", [
    ("import UIKit\n", "import UIKit\nimport AVFoundation\nimport CoreLocation\n", 1),
    ("// Override point for customization after application launch.\n",
     "// Override point for customization after application launch.\n        " + RESTORE + "\n        CarWatch.shared.start()\n", 1),
    ("    func applicationDidBecomeActive(_ application: UIApplication) {\n",
     "    func applicationDidBecomeActive(_ application: UIApplication) {\n        CarWatch.shared.flush()\n", 1),
])
p = pathlib.Path("ios/App/App/AppDelegate.swift")
p.write_text(p.read_text(encoding="utf-8") + CARWATCH, encoding="utf-8")
