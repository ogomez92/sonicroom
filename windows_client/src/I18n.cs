using System.Collections.Generic;

namespace SonicRoom.Windows;

/// <summary>
/// Minimal string table for the native client: en / es / fr (the same locales the web client
/// ships). <see cref="T"/> returns the active language's text, <see cref="F"/> formats with
/// positional {0}/{1} args. Strings are resolved at call time, so a language switch re-renders
/// everything the next time each label/announcement is produced (MainWindow.ApplyStrings pushes
/// the static XAML texts immediately).
///
/// The key set intentionally mirrors the web client's messages/{en,es,fr}.json vocabulary where
/// the two clients say the same thing, so announcements read identically across clients.
/// </summary>
public static class I18n
{
    /// <summary>Active language code: "en" | "es" | "fr". Unknown codes fall back to en.</summary>
    public static string Lang { get; set; } = "en";

    public static string T(string key)
    {
        if (!Table.TryGetValue(key, out var t)) return key; // fail readable, never throw
        return Lang switch { "es" => t.Es, "fr" => t.Fr, _ => t.En };
    }

    public static string F(string key, params object[] args) => string.Format(T(key), args);

    private static readonly Dictionary<string, (string En, string Es, string Fr)> Table = new()
    {
        // ---- connect screen -------------------------------------------------------------
        ["app_subtitle"] = ("Native Windows client", "Cliente nativo para Windows", "Client natif pour Windows"),
        ["header_language"] = ("Language", "Idioma", "Langue"),
        ["header_server"] = ("Server URL", "URL del servidor", "URL du serveur"),
        ["header_room"] = ("Room", "Sala", "Salon"),
        ["header_name"] = ("Display name", "Nombre visible", "Nom affiché"),
        ["header_mic"] = ("Microphone", "Micrófono", "Microphone"),
        ["header_speaker"] = ("Speaker", "Altavoz", "Haut-parleur"),
        ["system_default"] = ("System default", "Predeterminado del sistema", "Par défaut du système"),
        ["mic_test"] = ("Test microphone", "Probar micrófono", "Tester le micro"),
        ["mic_test_stop"] = ("Stop test", "Detener prueba", "Arrêter le test"),
        ["mic_level"] = ("Microphone level", "Nivel del micrófono", "Niveau du micro"),
        ["listen_only"] = ("Listen only (no microphone)", "Solo escuchar (sin micrófono)", "Écoute seule (sans micro)"),
        ["make_public"] = ("Make this room public (listed + vote-to-kick)", "Hacer pública esta sala (listada + expulsión por votos)", "Rendre ce salon public (listé + expulsion par vote)"),
        ["hifi_voice"] = ("Hi-fi voice (stereo, higher bitrate)", "Voz hi-fi (estéreo, mayor calidad)", "Voix hi-fi (stéréo, meilleur débit)"),
        ["hifi_next_call"] = ("Hi-fi voice applies from your next call.", "La voz hi-fi se aplicará en tu próxima llamada.", "La voix hi-fi s'appliquera à votre prochain appel."),
        ["hifi_voice_help"] = (
            "Applies from your next call. Cannot be combined with voice processing — checking one turns the other off",
            "Se aplica en tu próxima llamada. No se puede combinar con el procesamiento de voz: al activar uno se desactiva el otro",
            "S'applique à votre prochain appel. Incompatible avec le traitement de la voix : cocher l'un désactive l'autre"),
        ["voice_processing"] = ("Voice processing", "Procesamiento de voz", "Traitement de la voix"),
        ["voice_processing_help"] = (
            "Echo cancellation and noise suppression; your microphone level is never changed",
            "Cancelación de eco y reducción de ruido; el nivel del micrófono nunca se modifica",
            "Annulation de l'écho et suppression du bruit ; le niveau du microphone n'est jamais modifié"),
        ["hifi_disabled_for_voice_processing"] = (
            "Hi-fi voice was turned off because voice processing was enabled.",
            "La voz hi-fi se ha desactivado porque se activó el procesamiento de voz.",
            "La voix hi-fi a été désactivée car le traitement de la voix a été activé."),
        ["voice_processing_disabled_for_hifi"] = (
            "Voice processing was turned off because hi-fi voice was enabled.",
            "El procesamiento de voz se ha desactivado porque se activó la voz hi-fi.",
            "Le traitement de la voix a été désactivé car la voix hi-fi a été activée."),
        ["voice_processing_unavailable"] = (
            "Voice processing is unavailable. The raw microphone has been restored.",
            "El procesamiento de voz no está disponible. Se ha restaurado el micrófono sin procesar.",
            "Le traitement de la voix n'est pas disponible. Le microphone brut a été rétabli."),
        ["remembered_mic_unavailable"] = (
            "The selected microphone is unavailable. The system default microphone will be used.",
            "El micrófono seleccionado no está disponible. Se usará el micrófono predeterminado del sistema.",
            "Le microphone sélectionné n'est pas disponible. Le microphone par défaut du système sera utilisé."),
        ["remembered_speaker_unavailable"] = (
            "The selected speaker is unavailable. The system default speaker will be used.",
            "El altavoz seleccionado no está disponible. Se usará el altavoz predeterminado del sistema.",
            "Le haut-parleur sélectionné n'est pas disponible. Le haut-parleur par défaut du système sera utilisé."),
        ["join_call"] = ("Join call", "Unirse a la llamada", "Rejoindre l'appel"),
        ["connection_status"] = ("Connection status", "Estado de la conexión", "État de la connexion"),
        ["connecting"] = ("Connecting…", "Conectando…", "Connexion…"),
        ["public_rooms"] = ("Public rooms", "Salas públicas", "Salons publics"),
        ["refresh"] = ("Refresh", "Actualizar", "Actualiser"),
        ["refresh_rooms"] = ("Refresh public rooms", "Actualizar salas públicas", "Actualiser les salons publics"),
        ["no_public_rooms"] = ("No public rooms right now.", "No hay salas públicas ahora mismo.", "Aucun salon public pour le moment."),
        ["one_public_room"] = ("1 public room.", "1 sala pública.", "1 salon public."),
        ["n_public_rooms"] = ("{0} public rooms.", "{0} salas públicas.", "{0} salons publics."),
        ["could_not_load_rooms"] = ("Could not load public rooms: {0}", "No se han podido cargar las salas públicas: {0}", "Impossible de charger les salons publics : {0}"),
        ["room_set"] = ("Room set to {0}. Press Join call to enter.", "Sala cambiada a {0}. Pulsa Unirse a la llamada para entrar.", "Salon défini sur {0}. Appuyez sur Rejoindre l'appel pour entrer."),
        ["room_empty"] = ("{0} — empty", "{0} — vacía", "{0} — vide"),
        ["room_people"] = ("{0} — {1} in call: {2}", "{0} — {1} en llamada: {2}", "{0} — {1} en appel : {2}"),
        ["testing_mic"] = ("Testing {0} — you should hear yourself. Press again to stop.", "Probando {0} — deberías oírte. Pulsa de nuevo para parar.", "Test de {0} — vous devriez vous entendre. Appuyez à nouveau pour arrêter."),
        ["mic_test_stopped"] = ("Microphone test stopped", "Prueba de micrófono detenida", "Test du micro arrêté"),
        ["mic_test_failed"] = ("Microphone test failed: {0}", "La prueba del micrófono ha fallado: {0}", "Échec du test du micro : {0}"),

        // ---- call screen chrome ---------------------------------------------------------
        ["room_title"] = ("Room: {0}", "Sala: {0}", "Salon : {0}"),
        ["call_status"] = ("Call status", "Estado de la llamada", "État de l'appel"),
        ["participants"] = ("Participants", "Participantes", "Participants"),
        ["call_controls"] = ("Call controls", "Controles de la llamada", "Commandes de l'appel"),
        ["chat_header"] = ("Chat", "Chat", "Discussion"),
        ["chat_history"] = ("Chat history", "Historial del chat", "Historique de la discussion"),
        ["chat_placeholder"] = ("No messages yet.", "Aún no hay mensajes.", "Pas encore de messages."),
        ["message_placeholder"] = ("Message", "Mensaje", "Message"),
        ["send"] = ("Send", "Enviar", "Envoyer"),
        ["send_message"] = ("Send message", "Enviar mensaje", "Envoyer le message"),
        ["mute"] = ("Mute", "Silenciar", "Muet"),
        ["mute_mic"] = ("Mute microphone", "Silenciar micrófono", "Couper le micro"),
        ["deafen"] = ("Deafen", "Ensordecer", "Assourdir"),
        ["autoduck"] = ("Auto-duck music", "Atenuado automático", "Atténuer la musique"),
        ["autoduck_name"] = ("Auto-duck music under voices", "Atenuar automáticamente la música bajo las voces", "Atténuer automatiquement la musique sous les voix"),
        ["whos_speaking"] = ("Who's speaking", "Quién habla", "Qui parle"),
        ["whos_speaking_name"] = ("Announce who is speaking", "Anunciar quién está hablando", "Annoncer qui parle"),
        ["share_app_audio"] = ("Share app audio", "Compartir audio de apps", "Partager l'audio d'apps"),
        ["stop_sharing"] = ("Stop sharing", "Dejar de compartir", "Arrêter le partage"),
        ["extra_mics"] = ("Extra mics", "Micros adicionales", "Micros supplémentaires"),
        ["play_file"] = ("Play media", "Reproducir contenido", "Lire un média"),
        ["stop_file"] = ("Stop media", "Detener contenido", "Arrêter le média"),
        ["change_file"] = ("Change media", "Cambiar contenido", "Changer de média"),
        ["media_dialog_title"] = ("Play media", "Reproducir contenido", "Lire un média"),
        ["media_url"] = ("Media or YouTube URL", "URL del contenido o de YouTube", "URL du média ou YouTube"),
        ["media_url_hint"] = ("Enter an HTTP or HTTPS media URL, including a YouTube watch link, or choose a local file.", "Introduce una URL HTTP o HTTPS, incluido un enlace de YouTube, o elige un archivo local.", "Saisissez une URL HTTP ou HTTPS, y compris un lien YouTube, ou choisissez un fichier local."),
        ["choose_file"] = ("Choose file", "Elegir archivo", "Choisir un fichier"),
        ["invalid_media_url"] = ("Enter a valid HTTP or HTTPS media URL.", "Introduce una URL de contenido HTTP o HTTPS válida.", "Saisissez une URL de média HTTP ou HTTPS valide."),
        ["record"] = ("Record", "Grabar", "Enregistrer"),
        ["stop_recording"] = ("Stop recording", "Detener grabación", "Arrêter l'enregistrement"),
        ["download_recording"] = ("Download recording", "Descargar grabación", "Télécharger l'enregistrement"),
        ["download_mixed"] = ("Mixed (OGG)", "Mezclada (OGG)", "Mixé (OGG)"),
        ["download_tracks"] = ("Separate tracks (ZIP)", "Pistas separadas (ZIP)", "Pistes séparées (ZIP)"),
        ["stream"] = ("Stream", "Retransmitir", "Diffuser"),
        ["stop_streaming"] = ("Stop streaming", "Detener retransmisión", "Arrêter la diffusion"),
        ["leave"] = ("Leave", "Salir", "Quitter"),
        ["leave_call"] = ("Leave call", "Salir de la llamada", "Quitter l'appel"),
        ["mic_gain"] = ("Mic gain", "Ganancia del micro", "Gain du micro"),
        ["mic_gain_name"] = ("Microphone gain, percent", "Ganancia del micrófono, porcentaje", "Gain du microphone, pourcentage"),
        ["master"] = ("Master", "General", "Général"),
        ["master_volume_name"] = ("Master volume, percent", "Volumen general, porcentaje", "Volume général, pourcentage"),
        ["media_volume"] = ("Media", "Contenido", "Média"),
        ["media_volume_name"] = ("Media volume for you and remote listeners, percent", "Volumen del contenido para ti y los oyentes remotos, porcentaje", "Volume du média pour vous et les auditeurs distants, pourcentage"),

        // ---- participant rows -------------------------------------------------------------
        ["peer_muted_label"] = ("muted", "silenciado", "muet"),
        ["caster_label"] = ("music caster", "emisor de música", "diffuseur de musique"),
        ["vote_label"] = ("{0} to kick", "{0} para expulsar", "{0} pour expulser"),
        ["row_votes"] = ("{0} votes to kick", "{0} votos para expulsar", "{0} votes pour expulser"),
        ["volume_label"] = ("Volume for {0}, percent", "Volumen de {0}, porcentaje", "Volume de {0}, pourcentage"),
        ["local_mute_btn"] = ("Mute", "Silenciar", "Muet"),
        ["local_mute_label"] = ("Mute {0} locally (only for you)", "Silenciar a {0} localmente (solo para ti)", "Couper {0} localement (pour vous seulement)"),
        ["stop_stream_btn"] = ("Stop stream", "Detener transmisión", "Arrêter le flux"),
        ["stop_stream_label"] = ("Stop a stream from {0}", "Detener una transmisión de {0}", "Arrêter un flux de {0}"),
        ["remove_caster_btn"] = ("Remove", "Quitar", "Retirer"),
        ["remove_caster_label"] = ("Remove caster {0}", "Quitar el emisor {0}", "Retirer le diffuseur {0}"),
        ["kick_btn"] = ("Kick", "Expulsar", "Expulser"),
        ["kick_label"] = ("Kick {0}", "Expulsar a {0}", "Expulser {0}"),
        ["kick_label_votes"] = ("Kick {0} ({1} votes)", "Expulsar a {0} ({1} votos)", "Expulser {0} ({1} votes)"),

        // ---- join / leave / presence ------------------------------------------------------
        ["joined_room_alone"] = ("Joined room {0}. You're the only one here.", "Te has unido a la sala {0}. Eres la única persona aquí.", "Vous avez rejoint le salon {0}. Vous êtes seul ici."),
        ["joined_room_one"] = ("Joined room {0}. 1 other participant here.", "Te has unido a la sala {0}. Hay 1 participante más.", "Vous avez rejoint le salon {0}. 1 autre participant est là."),
        ["joined_room_n"] = ("Joined room {0}. {1} other participants here.", "Te has unido a la sala {0}. Hay {1} participantes más.", "Vous avez rejoint le salon {0}. {1} autres participants sont là."),
        ["joined_no_mic"] = ("You joined without a microphone. You can still listen and use text chat.", "Has entrado sin micrófono. Puedes escuchar y usar el chat de texto.", "Vous avez rejoint sans micro. Vous pouvez écouter et utiliser le chat."),
        ["mic_in_use"] = ("Microphone: {0}", "Micrófono: {0}", "Microphone : {0}"),
        ["failed_join"] = ("Failed to join: {0}", "No se ha podido entrar: {0}", "Impossible de rejoindre : {0}"),
        ["join_denied"] = ("Your request to join was denied.", "Tu solicitud para entrar no ha sido aceptada.", "Votre demande d'entrée a été refusée."),
        ["left_room"] = ("Left the room", "Has salido de la sala", "Vous avez quitté le salon"),
        ["waiting_admit"] = ("Waiting to be let in…", "Esperando a que te dejen entrar…", "En attente d'être admis…"),
        ["joined_the_room"] = ("{0} joined the room", "{0} ha entrado en la sala", "{0} a rejoint le salon"),
        ["left_the_room"] = ("{0} left the room", "{0} ha salido de la sala", "{0} a quitté le salon"),
        ["chat_joined"] = ("{0} joined", "{0} se ha unido", "{0} a rejoint"),
        ["chat_left"] = ("{0} left", "{0} ha salido", "{0} est parti"),

        // ---- mute / deafen ---------------------------------------------------------------
        ["mic_muted"] = ("Microphone muted", "Micrófono silenciado", "Micro coupé"),
        ["mic_unmuted"] = ("Microphone unmuted", "Micrófono activado", "Micro réactivé"),
        ["deafened"] = ("Deafened", "Ensordecido", "Assourdi"),
        ["undeafened"] = ("Undeafened", "Sonido restaurado", "Son rétabli"),
        ["peer_muted_announce"] = ("{0} muted their microphone", "{0} ha silenciado su micrófono", "{0} a coupé son micro"),
        ["peer_unmuted_announce"] = ("{0} unmuted their microphone", "{0} ha reactivado su micrófono", "{0} a réactivé son micro"),
        ["local_muted_announce"] = ("{0} muted for you only", "{0} silenciado para ti", "{0} coupé pour vous seulement"),
        ["local_unmuted_announce"] = ("{0} unmuted for you", "{0} reactivado para ti", "{0} rétabli pour vous"),

        // ---- recording / streaming --------------------------------------------------------
        ["recording_started"] = ("Recording started", "Grabación iniciada", "Enregistrement démarré"),
        ["recording_started_by"] = ("Recording started by {0}", "Grabación iniciada por {0}", "Enregistrement démarré par {0}"),
        ["recording_stopped"] = ("Recording stopped", "Grabación detenida", "Enregistrement arrêté"),
        ["recording_expired_announce"] = ("The recording is no longer available for download", "La grabación ya no está disponible para descargar", "L'enregistrement n'est plus disponible au téléchargement"),
        ["recording_action_failed"] = ("Recording action failed: {0}", "La acción de grabación ha fallado: {0}", "Échec de l'action d'enregistrement : {0}"),
        ["no_recording"] = ("No recording available.", "No hay ninguna grabación disponible.", "Aucun enregistrement disponible."),
        ["download_started"] = ("Downloading recording…", "Descargando grabación…", "Téléchargement de l'enregistrement…"),
        ["download_done"] = ("Recording saved to {0}", "Grabación guardada en {0}", "Enregistrement sauvegardé dans {0}"),
        ["download_failed"] = ("Download failed: {0}", "La descarga ha fallado: {0}", "Échec du téléchargement : {0}"),
        ["streaming_started"] = ("Live streaming started", "Retransmisión en directo iniciada", "Diffusion en direct démarrée"),
        ["streaming_started_by"] = ("Live streaming started by {0}", "{0} ha iniciado la retransmisión en directo", "Diffusion en direct démarrée par {0}"),
        ["streaming_stopped"] = ("Live streaming stopped", "Retransmisión en directo detenida", "Diffusion en direct arrêtée"),
        ["streaming_stopped_unexpected"] = ("Live streaming stopped unexpectedly", "La retransmisión en directo se ha detenido inesperadamente", "La diffusion en direct s'est arrêtée de façon inattendue"),
        ["streaming_failed"] = ("Live streaming stopped: {0}", "La retransmisión en directo se ha detenido: {0}", "Diffusion en direct arrêtée : {0}"),
        ["stop_streaming_failed"] = ("Stop streaming failed: {0}", "No se ha podido detener la retransmisión: {0}", "Échec de l'arrêt de la diffusion : {0}"),
        ["start_streaming_failed"] = ("Start streaming failed: {0}", "No se ha podido iniciar la retransmisión: {0}", "Échec du démarrage de la diffusion : {0}"),
        ["icecast_title"] = ("Start live streaming (Icecast)", "Iniciar retransmisión en directo (Icecast)", "Démarrer la diffusion en direct (Icecast)"),
        ["icecast_host"] = ("Icecast host", "Servidor Icecast", "Hôte Icecast"),
        ["port"] = ("Port", "Puerto", "Port"),
        ["mount"] = ("Mount", "Punto de montaje", "Point de montage"),
        ["username"] = ("Username", "Usuario", "Nom d'utilisateur"),
        ["password"] = ("Password", "Contraseña", "Mot de passe"),
        ["format"] = ("Format", "Formato", "Format"),
        ["start"] = ("Start", "Iniciar", "Démarrer"),
        ["invalid_port"] = ("Invalid port number.", "Número de puerto no válido.", "Numéro de port invalide."),

        // ---- ducking ----------------------------------------------------------------------
        ["ducking_on_by"] = ("{0} turned music auto-ducking on", "{0} ha activado el atenuado automático", "{0} a activé l'atténuation automatique de la musique"),
        ["ducking_off_by"] = ("{0} turned music auto-ducking off", "{0} ha desactivado el atenuado automático", "{0} a désactivé l'atténuation automatique de la musique"),
        ["ducking_toggle_failed"] = ("Could not change ducking: {0}", "No se ha podido cambiar el atenuado automático: {0}", "Impossible de modifier l'atténuation : {0}"),
        ["a_participant"] = ("a participant", "un participante", "un participant"),

        // ---- shares / files / extra mics ----------------------------------------------------
        ["share_title"] = ("App audio", "Audio de aplicaciones", "Audio d'applications"),
        ["share_dialog_title"] = ("Share application audio", "Compartir audio de una aplicación", "Partager l'audio d'une application"),
        ["share_dialog_text"] = ("Check the application(s) whose audio to share:", "Marca las aplicaciones cuyo audio quieres compartir:", "Cochez les applications dont vous voulez partager l'audio :"),
        ["share_only_checked"] = ("Share only the checked app(s)", "Compartir solo las apps marcadas", "Partager uniquement les apps cochées"),
        ["share_all_except"] = ("Share everything except the checked app", "Compartir todo excepto la app marcada", "Tout partager sauf l'app cochée"),
        ["start_sharing"] = ("Start sharing", "Empezar a compartir", "Commencer le partage"),
        ["cancel"] = ("Cancel", "Cancelar", "Annuler"),
        ["apply"] = ("Apply", "Aplicar", "Appliquer"),
        ["no_app_checked"] = ("No app checked; sharing not started.", "Ninguna app marcada; no se ha iniciado el uso compartido.", "Aucune app cochée ; partage non démarré."),
        ["app_playing"] = ("{0} (playing)", "{0} (reproduciendo)", "{0} (en lecture)"),
        ["you_started_sharing"] = ("You started sharing audio", "Has empezado a compartir audio", "Vous avez commencé à partager l'audio"),
        ["you_stopped_sharing"] = ("You stopped sharing audio", "Has dejado de compartir audio", "Vous avez arrêté de partager l'audio"),
        ["share_capture_failed"] = ("Could not start app audio capture — see the log.", "No se ha podido iniciar la captura de audio — mira el registro.", "Impossible de démarrer la capture audio — voir le journal."),
        ["share_failed"] = ("Share failed: {0}", "El uso compartido ha fallado: {0}", "Échec du partage : {0}"),
        ["share_started_peer"] = ("{0} started sharing audio", "{0} ha empezado a compartir audio", "{0} a commencé à partager l'audio"),
        ["share_stopped_peer"] = ("{0} stopped sharing audio", "{0} ha dejado de compartir audio", "{0} a arrêté de partager l'audio"),
        ["file_started_peer"] = ("{0} started streaming media", "{0} ha empezado a emitir contenido", "{0} a commencé à diffuser un média"),
        ["file_stopped_peer"] = ("{0} stopped streaming media", "{0} ha dejado de emitir contenido", "{0} a arrêté de diffuser un média"),
        ["mic_stream_started_peer"] = ("{0} started streaming an extra microphone", "{0} ha empezado a emitir un micrófono adicional", "{0} a commencé à diffuser un micro supplémentaire"),
        ["mic_stream_stopped_peer"] = ("{0} stopped an extra microphone", "{0} ha detenido un micrófono adicional", "{0} a arrêté un micro supplémentaire"),
        ["extra_mics_title"] = ("Extra microphones", "Micrófonos adicionales", "Micros supplémentaires"),
        ["extra_mics_text"] = ("Check input devices to stream as extra microphones:", "Marca los dispositivos de entrada para emitirlos como micrófonos adicionales:", "Cochez les périphériques d'entrée à diffuser comme micros supplémentaires :"),
        ["mono_label"] = ("Mono", "Mono", "Mono"),
        ["stereo_label"] = ("Stereo", "Estéreo", "Stéréo"),
        ["mono_for"] = ("Mono for {0}", "Mono para {0}", "Mono pour {0}"),
        ["stereo_for"] = ("Stereo for {0}", "Estéreo para {0}", "Stéréo pour {0}"),
        ["streaming_extra_mic"] = ("Streaming extra mic {0}", "Emitiendo el micro adicional {0}", "Diffusion du micro supplémentaire {0}"),
        ["streaming_extra_mic_stereo"] = ("Streaming extra mic {0} in stereo", "Emitiendo el micro adicional {0} en estéreo", "Diffusion du micro supplémentaire {0} en stéréo"),
        ["stopped_extra_mic"] = ("Stopped extra mic {0}", "Micro adicional {0} detenido", "Micro supplémentaire {0} arrêté"),
        ["extra_mic_failed_start"] = ("Could not start extra mic {0}.", "No se ha podido iniciar el micro adicional {0}.", "Impossible de démarrer le micro supplémentaire {0}."),
        ["extra_mic_failed"] = ("Extra mic {0} failed: {1}", "El micro adicional {0} ha fallado: {1}", "Échec du micro supplémentaire {0} : {1}"),
        ["playing_file"] = ("Playing {0}", "Reproduciendo {0}", "Lecture de {0}"),
        ["you_swapped_file"] = ("Now playing {0}", "Ahora suena {0}", "Lecture maintenant de {0}"),
        ["you_stopped_file"] = ("You stopped streaming the media", "Has dejado de emitir el contenido", "Vous avez arrêté de diffuser le média"),
        ["file_failed"] = ("Media playback failed: {0}", "La reproducción del contenido ha fallado: {0}", "Échec de la lecture du média : {0}"),
        ["media_finished"] = ("Media playback finished", "La reproducción del contenido ha terminado", "La lecture du média est terminée"),
        ["now_streaming"] = ("{0} is now streaming {1}", "{0} ahora está emitiendo {1}", "{0} diffuse maintenant {1}"),

        // ---- anti-troll ---------------------------------------------------------------------
        ["source_share"] = ("shared audio", "audio compartido", "audio partagé"),
        ["source_file"] = ("media stream", "contenido en emisión", "flux multimédia"),
        ["source_mic"] = ("extra microphone", "micrófono adicional", "micro supplémentaire"),
        ["stream_stopped_yours"] = ("Your {0} was stopped by another participant", "Otro participante ha detenido tu {0}", "Votre {0} a été arrêté par un autre participant"),
        ["stream_stopped_of"] = ("{0}'s {1} was stopped", "Se ha detenido el {1} de {0}", "Le {1} de {0} a été arrêté"),
        ["stop_stream_failed"] = ("Could not stop the stream: {0}", "No se ha podido detener la transmisión: {0}", "Impossible d'arrêter le flux : {0}"),
        ["remove_caster_title"] = ("Remove music caster", "Quitar el emisor de música", "Retirer le diffuseur de musique"),
        ["remove_caster_confirm"] = ("Remove {0} from the room? Anyone can remove a music caster.", "¿Quitar a {0} de la sala? Cualquiera puede quitar un emisor de música.", "Retirer {0} du salon ? N'importe qui peut retirer un diffuseur de musique."),
        ["remove"] = ("Remove", "Quitar", "Retirer"),
        ["remove_caster_failed"] = ("Could not remove the caster: {0}", "No se ha podido quitar el emisor: {0}", "Impossible de retirer le diffuseur : {0}"),
        ["caster_removed"] = ("Music caster {0} was removed", "El emisor de música {0} ha sido expulsado", "Le diffuseur de musique {0} a été retiré"),

        // ---- moderation ----------------------------------------------------------------------
        ["room_now_public"] = ("This room is now public", "Esta sala ahora es pública", "Ce salon est maintenant public"),
        ["someone"] = ("Someone", "Alguien", "Quelqu'un"),
        ["voted_kick"] = ("{0} voted to kick {1}", "{0} ha votado para expulsar a {1}", "{0} a voté pour expulser {1}"),
        ["withdrew_kick"] = ("{0} withdrew their vote to kick {1}", "{0} ha retirado su voto para expulsar a {1}", "{0} a retiré son vote pour expulser {1}"),
        ["removed_by_vote"] = ("{0} was removed from the room by vote", "{0} ha sido expulsado de la sala por votación", "{0} a été expulsé du salon par vote"),
        ["cannot_vote"] = ("Cannot vote to kick: {0}", "No se puede votar la expulsión: {0}", "Impossible de voter l'expulsion : {0}"),
        ["you_removed"] = ("You were removed from the room", "Has sido expulsado de la sala", "Vous avez été retiré du salon"),
        ["wants_join"] = ("{0} wants to join.", "{0} quiere entrar.", "{0} veut rejoindre."),
        ["someone_wants_join"] = ("Someone wants to join", "Alguien quiere entrar", "Quelqu'un veut rejoindre"),
        ["let_them_in"] = ("{0} is asking to join this room. Let them in?", "{0} pide entrar en esta sala. ¿Le dejas entrar?", "{0} demande à rejoindre ce salon. L'admettre ?"),
        ["admit"] = ("Admit", "Permitir", "Admettre"),
        ["deny"] = ("Deny", "Rechazar", "Refuser"),
        ["admitted"] = ("Admitted {0}", "Has permitido entrar a {0}", "{0} admis"),
        ["denied"] = ("Denied {0}", "Has rechazado a {0}", "{0} refusé"),
        ["join_decision_failed"] = ("Join decision failed: {0}", "La decisión de admisión ha fallado: {0}", "Échec de la décision d'admission : {0}"),

        // ---- speaking indicators ---------------------------------------------------------------
        ["speaking_you"] = ("You", "Tú", "Vous"),
        ["speaking_none"] = ("No one is speaking right now.", "Nadie está hablando ahora mismo.", "Personne ne parle en ce moment."),
        ["speaking_list"] = ("Speaking: {0}", "Hablando: {0}", "En train de parler : {0}"),

        // ---- chat ---------------------------------------------------------------------------
        ["chat_sent"] = ("sent {0}", "enviado {0}", "envoyé {0}"),
        ["copied"] = ("Copied", "Copiado", "Copié"),
        ["copy_failed"] = ("Copy failed: {0}", "No se ha podido copiar: {0}", "Échec de la copie : {0}"),
        ["no_message"] = ("No message {0}", "No hay mensaje {0}", "Pas de message {0}"),
        ["chat_hint"] = (
            "Press Alt plus a number from 1 to 0 to hear the last ten messages, newest first. Press the same number again to copy that message.",
            "Pulsa Alt más un número del 1 al 0 para oír los últimos diez mensajes, del más reciente al más antiguo. Pulsa el mismo número otra vez para copiar ese mensaje.",
            "Appuyez sur Alt plus un chiffre de 1 à 0 pour entendre les dix derniers messages, du plus récent au plus ancien. Appuyez de nouveau sur le même chiffre pour copier ce message."),

        // ---- relative time --------------------------------------------------------------------
        ["time_just_now"] = ("just now", "ahora mismo", "à l'instant"),
        ["unit_minute"] = ("minute", "minuto", "minute"),
        ["unit_minutes"] = ("minutes", "minutos", "minutes"),
        ["unit_hour"] = ("hour", "hora", "heure"),
        ["unit_hours"] = ("hours", "horas", "heures"),
        ["unit_day"] = ("day", "día", "jour"),
        ["unit_days"] = ("days", "días", "jours"),
        ["time_ago"] = ("{0} ago", "hace {0}", "il y a {0}"),
        ["time_in"] = ("in {0}", "en {0}", "dans {0}"),
    };
}
