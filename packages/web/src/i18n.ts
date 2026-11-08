/**
 * Other languages. English text is the key, so a string with no translation yet simply shows in
 * English. Each person picks a language per device (like the theme); the default follows the
 * browser or Windows. Adding a language: a column below and an entry in LANGUAGES.
 */

export const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "es", name: "Español" },
  { code: "fr", name: "Français" },
  { code: "de", name: "Deutsch" },
  { code: "pt", name: "Português" },
] as const;

export type Language = (typeof LANGUAGES)[number]["code"];
const OTHER = ["es", "fr", "de", "pt"] as const;

/** English → [Spanish, French, German, Portuguese]. */
const STRINGS: Record<string, [string, string, string, string]> = {
  // Menus
  Home: ["Inicio", "Accueil", "Startseite", "Início"],
  Library: ["Biblioteca", "Bibliothèque", "Bibliothek", "Biblioteca"],
  Games: ["Juegos", "Jeux", "Spiele", "Jogos"],
  Emulation: ["Emulación", "Émulation", "Emulation", "Emulação"],
  Updates: ["Actualizaciones", "Mises à jour", "Updates", "Atualizações"],
  "Get the app": ["Descargar la app", "Obtenir l'appli", "App holen", "Baixar o app"],
  Discover: ["Descubrir", "Découvrir", "Entdecken", "Descobrir"],
  Wishlist: ["Lista de deseos", "Liste de souhaits", "Wunschliste", "Lista de desejos"],
  Calendar: ["Calendario", "Calendrier", "Kalender", "Calendário"],
  Requests: ["Peticiones", "Demandes", "Wünsche", "Pedidos"],
  News: ["Noticias", "Actualités", "Neuigkeiten", "Notícias"],
  Browser: ["Navegador", "Navigateur", "Browser", "Navegador"],
  Family: ["Familia", "Famille", "Familie", "Família"],
  "Game night": ["Noche de juegos", "Soirée jeux", "Spieleabend", "Noite de jogos"],
  "Family wall": ["Muro familiar", "Mur de famille", "Familienwand", "Mural da família"],
  Downloads: ["Descargas", "Téléchargements", "Downloads", "Downloads"],
  Settings: ["Ajustes", "Réglages", "Einstellungen", "Configurações"],
  "More ▾": ["Más ▾", "Plus ▾", "Mehr ▾", "Mais ▾"],
  Menu: ["Menú", "Menu", "Menü", "Menu"],
  "Sign out": ["Cerrar sesión", "Se déconnecter", "Abmelden", "Sair"],
  Profile: ["Perfil", "Profil", "Profil", "Perfil"],
  "Service token": ["Token de servicio", "Jeton de service", "Dienst-Token", "Token de serviço"],
  // Sign in
  "Create the admin account": ["Crear la cuenta de administrador", "Créer le compte administrateur", "Admin-Konto anlegen", "Criar a conta de administrador"],
  "Sign in": ["Iniciar sesión", "Se connecter", "Anmelden", "Entrar"],
  Continue: ["Continuar", "Continuer", "Weiter", "Continuar"],
  "Create admin": ["Crear administrador", "Créer l'admin", "Admin anlegen", "Criar administrador"],
  "Use my passkey": ["Usar mi llave de acceso", "Utiliser ma clé d'accès", "Meinen Passkey verwenden", "Usar minha chave de acesso"],
  "Sign in with a passkey": ["Entrar con llave de acceso", "Se connecter avec une clé d'accès", "Mit Passkey anmelden", "Entrar com chave de acesso"],
  "Sign in with a password": ["Entrar con contraseña", "Se connecter avec un mot de passe", "Mit Passwort anmelden", "Entrar com senha"],
  "Sign in with a code": ["Entrar con un código", "Se connecter avec un code", "Mit Code anmelden", "Entrar com um código"],
  Username: ["Usuario", "Nom d'utilisateur", "Benutzername", "Usuário"],
  Password: ["Contraseña", "Mot de passe", "Passwort", "Senha"],
  // Home rows (titles come from the server in English)
  "Continue playing": ["Seguir jugando", "Reprendre", "Weiterspielen", "Continuar jogando"],
  "Recently added": ["Añadidos recientemente", "Ajouts récents", "Neu hinzugefügt", "Adicionados recentemente"],
  "New on the Emulation shelf": ["Novedades en Emulación", "Nouveau dans Émulation", "Neu bei Emulation", "Novidades em Emulação"],
  "Top rated": ["Mejor valorados", "Les mieux notés", "Am besten bewertet", "Mais bem avaliados"],
  "Great with a controller": ["Geniales con mando", "Parfaits à la manette", "Toll mit Controller", "Ótimos com controle"],
  "Play together": ["Jugar juntos", "Jouer ensemble", "Zusammen spielen", "Jogar juntos"],
  "Family friendly": ["Para toda la familia", "Pour toute la famille", "Familienfreundlich", "Para toda a família"],
  "Ready to play": ["Listo para jugar", "Prêts à jouer", "Bereit zum Spielen", "Pronto para jogar"],
  Installed: ["Instalados", "Installés", "Installiert", "Instalados"],
  "Coming soon": ["Próximamente", "Bientôt", "Demnächst", "Em breve"],
  "Latest news": ["Últimas noticias", "Dernières actualités", "Neueste Nachrichten", "Últimas notícias"],
  // Game page
  Overview: ["Resumen", "Aperçu", "Übersicht", "Visão geral"],
  "Updates & mods": ["Actualizaciones y mods", "Mises à jour et mods", "Updates & Mods", "Atualizações e mods"],
  "Saves & files": ["Partidas y archivos", "Sauvegardes et fichiers", "Spielstände & Dateien", "Saves e arquivos"],
  Admin: ["Administración", "Admin", "Admin", "Admin"],
  "Install on this PC": ["Instalar en este PC", "Installer sur ce PC", "Auf diesem PC installieren", "Instalar neste PC"],
  Screenshots: ["Capturas", "Captures d'écran", "Screenshots", "Capturas de tela"],
  Trailer: ["Tráiler", "Bande-annonce", "Trailer", "Trailer"],
  Files: ["Archivos", "Fichiers", "Dateien", "Arquivos"],
  Manual: ["Manual", "Manuel", "Anleitung", "Manual"],
  "Read the manual": ["Leer el manual", "Lire le manuel", "Anleitung lesen", "Ler o manual"],
  "Open in a new tab": ["Abrir en otra pestaña", "Ouvrir dans un nouvel onglet", "In neuem Tab öffnen", "Abrir em nova aba"],
  Close: ["Cerrar", "Fermer", "Schließen", "Fechar"],
  "Manual saved.": ["Manual guardado.", "Manuel enregistré.", "Anleitung gespeichert.", "Manual salvo."],
  "Upload a PDF": ["Subir un PDF", "Envoyer un PDF", "PDF hochladen", "Enviar um PDF"],
  "Uploading…": ["Subiendo…", "Envoi…", "Wird hochgeladen…", "Enviando…"],
  "Remove the uploaded one": ["Quitar el subido", "Retirer celui envoyé", "Hochgeladene entfernen", "Remover o enviado"],
  "Uploaded manual removed.": ["Manual subido eliminado.", "Manuel envoyé retiré.", "Hochgeladene Anleitung entfernt.", "Manual enviado removido."],
  "PDFs in the game's own files show up by themselves. Upload one here for games that don't come with it.": [
    "Los PDF que vienen con el juego aparecen solos. Sube uno aquí para los juegos que no lo traen.",
    "Les PDF fournis avec le jeu apparaissent tout seuls. Envoyez-en un ici pour les jeux qui n'en ont pas.",
    "PDFs in den Dateien des Spiels erscheinen von selbst. Lade hier eine hoch, wenn das Spiel keine mitbringt.",
    "PDFs que vêm com o jogo aparecem sozinhos. Envie um aqui para jogos que não trazem.",
  ],
  // In-game menu
  "Back to the game": ["Volver al juego", "Retour au jeu", "Zurück zum Spiel", "Voltar ao jogo"],
  "Family chat": ["Chat familiar", "Discussion familiale", "Familienchat", "Chat da família"],
  Send: ["Enviar", "Envoyer", "Senden", "Enviar"],
  // Attract mode and previews
  "Press any button": ["Pulsa cualquier botón", "Appuyez sur un bouton", "Beliebige Taste drücken", "Aperte qualquer botão"],
  "Video previews": ["Vistas previas en vídeo", "Aperçus vidéo", "Videovorschauen", "Prévias em vídeo"],
  "Play a game's trailer, muted, when you rest on it in the library.": [
    "Reproduce el tráiler sin sonido al detenerte en un juego de la biblioteca.",
    "Lit la bande-annonce sans le son quand vous restez sur un jeu de la bibliothèque.",
    "Spielt den Trailer stumm ab, wenn du in der Bibliothek auf einem Spiel bleibst.",
    "Toca o trailer sem som quando você para em um jogo na biblioteca.",
  ],
  "Attract mode": ["Modo exhibición", "Mode démo", "Attract-Modus", "Modo demonstração"],
  "When the app sits idle with a controller, show trailers from the library until someone presses a button.": [
    "Si la app se queda quieta con mando, muestra tráileres de la biblioteca hasta que alguien pulse un botón.",
    "Quand l'appli reste inactive avec une manette, montre des bandes-annonces de la bibliothèque jusqu'à ce qu'on appuie sur un bouton.",
    "Wenn die App mit Controller unberührt bleibt, laufen Trailer aus der Bibliothek, bis jemand eine Taste drückt.",
    "Quando o app fica parado com controle, mostra trailers da biblioteca até alguém apertar um botão.",
  ],
  Off: ["Desactivado", "Désactivé", "Aus", "Desligado"],
  "After {n} minutes": ["Tras {n} minutos", "Après {n} minutes", "Nach {n} Minuten", "Após {n} minutos"],
  Language: ["Idioma", "Langue", "Sprache", "Idioma"],
  "Menus and buttons in this language, on this device. Game descriptions stay as the stores write them.": [
    "Menús y botones en este idioma, en este dispositivo. Las descripciones de los juegos se quedan como las escriben las tiendas.",
    "Menus et boutons dans cette langue, sur cet appareil. Les descriptions des jeux restent telles que les boutiques les écrivent.",
    "Menüs und Tasten in dieser Sprache, auf diesem Gerät. Spielbeschreibungen bleiben so, wie die Shops sie schreiben.",
    "Menus e botões neste idioma, neste dispositivo. As descrições dos jogos ficam como as lojas escrevem.",
  ],
  "Same as this device": ["Igual que el dispositivo", "Comme l'appareil", "Wie das Gerät", "Igual ao dispositivo"],
};

const KEY = "gm-language";

function stored(): Language | "" {
  try {
    const v = localStorage.getItem(KEY) ?? "";
    return LANGUAGES.some((l) => l.code === v) ? (v as Language) : "";
  } catch {
    return "";
  }
}

function fromDevice(): Language {
  const langs = typeof navigator === "undefined" ? [] : (navigator.languages ?? [navigator.language]);
  for (const l of langs) {
    const code = l?.slice(0, 2).toLowerCase();
    if (LANGUAGES.some((x) => x.code === code)) return code as Language;
  }
  return "en";
}

let current: Language = stored() || fromDevice();
if (typeof document !== "undefined") document.documentElement.lang = current;

/** The language in use, and what was picked ("" follows the device). */
export function language(): { current: Language; picked: Language | "" } {
  return { current, picked: stored() };
}

/** Picks a language for this device ("" follows the device) and reloads, so every page redraws in it. */
export function setLanguage(code: Language | ""): void {
  try {
    if (code) localStorage.setItem(KEY, code);
    else localStorage.removeItem(KEY);
  } catch {
    // private mode: this visit only
  }
  current = code || fromDevice();
  if (typeof location !== "undefined") location.reload();
}

/** Translates English text; {name} placeholders are filled from vars. Unknown text stays English. */
export function t(text: string, vars?: Record<string, string | number>, lang: Language = current): string {
  const i = lang === "en" ? -1 : OTHER.indexOf(lang);
  let out = i < 0 ? text : (STRINGS[text]?.[i] ?? text);
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  return out;
}

/** For tests: every English key and its translations. */
export const TRANSLATIONS = STRINGS;
