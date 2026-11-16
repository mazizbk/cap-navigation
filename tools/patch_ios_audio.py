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

# 2. Démarrage de l'application
patch("ios/App/App/AppDelegate.swift", [
    ("import UIKit\n", "import UIKit\nimport AVFoundation\n", 1),
    ("// Override point for customization after application launch.\n",
     "// Override point for customization after application launch.\n        " + RESTORE + "\n", 1),
])
