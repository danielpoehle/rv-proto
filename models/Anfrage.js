// models/Anfrage.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Sub-Schema für die gewünschten Slot-Abschnitte innerhalb einer Anfrage
const gewuenschterSlotAbschnittSchema = new Schema({
    von: { type: String, required: true },
    bis: { type: String, required: true },
    Abfahrtszeit: { // Gewünschte Abfahrtszeit für diesen spezifischen Abschnitt
        stunde: { type: Number, required: true, min: 0, max: 23 },
        minute: { type: Number, required: true, min: 0, max: 59 }
    },
    Ankunftszeit: { // NEU: Gewünschte Ankunftszeit für diesen spezifischen Abschnitt
        stunde: { type: Number, required: true, min: 0, max: 23 },
        minute: { type: Number, required: true, min: 0, max: 59 }
    }
}, { _id: false });

// Sub-Schema für den Status einer einzelnen Slot-Zuweisung innerhalb einer Anfrage
const zugewiesenerSlotMitStatusSchema = new Schema({
    slot: { // Referenz auf das Slot-Muster (definiert für eine spezifische globale relative KW)
        type: Schema.Types.ObjectId,
        ref: 'Slot',
        required: true
    },
    statusEinzelzuweisung: {
        type: String,
        required: true,
        enum: [
            'initial_in_konfliktpruefung_topf', // Direkt nach Zuordnung, bevor Topf-Konfliktbearbeitung beginnt
            'wartet_entgeltentscheidung_topf',    // Aktiv im Topf-Konflikt, wartet auf Entgelt-basierte Entscheidung
            'wartet_hoechstpreis_topf',         // Aktiv im Topf-Konflikt, wartet auf Höchstpreis-Entscheidung
            'bestaetigt_topf',                  // Hat Kapazität im Topf-Konflikt erhalten (allgemein oder nach Verzicht)
            'bestaetigt_topf_entgelt',          // Im Topf-Konflikt durch Entgelt zugewiesen
            'bestaetigt_topf_hoechstpreis',     // Im Topf-Konflikt durch Höchstpreis zugewiesen
            'abgelehnt_topf_verzichtet',        // Für diesen Topf-Konflikt verzichtet (Anfrage hat verzichtet)
            'abgelehnt_topf_verschoben',        // NEU (oder z.B. 'alternativ_bestaetigt_topf')
            'abgelehnt_topf_entgelt',           // Im Topf-Konflikt wegen Entgelt abgelehnt
            'abgelehnt_topf_hoechstpreis',      // Im Topf-Konflikt bei Höchstpreis unterlegen
            'abgelehnt_topf_kapazitaet',        // Im Topf-Konflikt wegen Kapazität (allgemein) abgelehnt
            'abgelehnt_topf_hoechstpreis_ungueltig', // im Höchstpreisverfahren ungültiges Gebot abgegeben
            'abgelehnt_topf_hoechstpreis_kein_gebot', //im Höchstpreisverfahren kein Gebot abgegeben
            // Später kommen hier Status für Slot-Level Konflikte hinzu, z.B.:
            // 'in_konfliktpruefung_slot',
            // 'bestaetigt_final_slot',
            // 'abgelehnt_slot_prioritaet'
        ],
        default: 'initial_in_konfliktpruefung_topf'
    }
    // Man könnte hier noch Referenzen hinzufügen, z.B. auf das KonfliktDokument, das zu einer Entscheidung geführt hat
}, { _id: false });

const anfrageSchema = new Schema({
    Zugnummer: { type: String, required: true, index: true },
    EVU: { type: String, required: true, index: true },
    AnfrageID_Sprechend: { type: String, unique: true, sparse: true, index: true },
    ListeGewuenschterSlotAbschnitte: {
        type: [gewuenschterSlotAbschnittSchema],
        required: true,
        validate: [list => list.length > 0, 'Es muss mindestens ein Slot-Abschnitt angefragt werden.']
    },
    Verkehrsart: {
        type: String,
        required: true,
        enum: ['SPFV', 'SPNV', 'SGV']
    },
    Verkehrstag: {
        type: String,
        required: true,
        enum: ['Mo-Fr', 'Sa+So', 'täglich']
    },
    Zeitraum: {
        start: { type: Date, required: true },
        ende: { type: Date, required: true }
    },
    Email: { type: String, required: true },
    Entgelt: { type: Number, default: null }, // Wird nach Slot-Zuweisung berechnet
    ZugewieseneSlots: [zugewiesenerSlotMitStatusSchema], // NEUE STRUKTUR
    Status: { // Der Gesamtstatus der Anfrage
        type: String,
        required: true,
        enum: [
            'eingegangen',              // Neu, noch nicht validiert
            'validiert',                // Grundprüfung OK
            'ungueltig',                // Grundprüfung nicht OK
            'in_zuordnung',             // Slots werden gesucht/gemappt
            'zuordnung_fehlgeschlagen', // Keine passenden Slot-Muster gefunden
            'in_konfliktloesung_topf',  // Mindestens ein zugewiesener Slot ist Teil eines Topf-Konflikts
            'vollstaendig_bestaetigt_topf', // alle Topf-Konflikte gewonnen, Bereitschaft für Slot-Konflikte 
            'teilweise_bestaetigt_topf', // nicht alle Topf-Konflikte gewonnen aber fertig, Bereitschaft für Slot-Konflikte
            // 'in_konfliktloesung_slot', // Später: Mindestens ein Slot ist im Slot-Level-Konflikt
            'teilweise_final_bestaetigt',// Einige Slot-Zuweisungen sind final bestätigt, andere nicht/abgelehnt
            'vollstaendig_final_bestaetigt',// Alle gewünschten Slot-Zuweisungen final bestätigt
            'final_abgelehnt',          // Keine Slot-Zuweisungen konnten final bestätigt werden
            'storniert_nutzer',         // Nutzer hat storniert (könnte ein neuer Status sein)
            'storniert_system'          // System hat storniert (z.B. nach Verzicht in Konflikt)
        ],
        default: 'eingegangen'
    },
    Validierungsfehler: [{ type: String }],    
}, { timestamps: true });

anfrageSchema.pre('save', function(next) {
    if (this.isModified('EVU') || this.isModified('Zugnummer') || !this.AnfrageID_Sprechend) {
        this.AnfrageID_Sprechend = `${this.EVU}-${this.Zugnummer}`;
    }
    next();
});

// NEUE METHODE zur Aktualisierung des Gesamtstatus der Anfrage
anfrageSchema.methods.updateGesamtStatus = async function() {
    if (this.ZugewieseneSlots.length === 0) {
        if (this.ListeGewuenschterSlotAbschnitte.length > 0) {
            this.Status = 'final_abgelehnt'; // Keine Slots zugewiesen trotz Wunsch
            console.log('Gar keine Slots zugewiesen trotz Wunsch');
        } else {
            // Keine gewünschten Abschnitte, keine zugewiesenen Slots -> Status sollte hier nicht relevant sein
            console.log(' Keine gewünschten Abschnitte, keine zugewiesenen Slots');
        }
        return;
    }

    // const anzahlGewuenschterAbschnitte = this.ListeGewuenschterSlotAbschnitte.length;
    // Die "erwartete" Anzahl an zugewiesenen Slot-Instanzen ist schwer hier exakt zu bestimmen,
    // da ein gewünschter Abschnitt zu mehreren Slot-Instanzen über KWs/VT führen kann.
    // Wir prüfen daher die Status der vorhandenen zugewiesenen Slots.

    let alleEinzelZuweisungenAbgeschlossen = true; // Sind alle Topf-Konflikte für diese Slots entschieden?
    let mindestensEineEinzelZuweisungBestaetigtTopf = false;
    let alleEinzelZuweisungenBestaetigtTopf = true;

    for (const zuweisung of this.ZugewieseneSlots) {
        const status = zuweisung.statusEinzelzuweisung;
        console.log(`Slot ${zuweisung.slot._id} in Status ${status}`)
        if (status === 'initial_in_konfliktpruefung_topf' || status.startsWith('wartet_')) {
            alleEinzelZuweisungenAbgeschlossen = false;
            //console.log(`Slot ${zuweisung} wartet.`);
            //Ein Slot wartet noch auf Topf-Entscheidung
        }
        if (status.startsWith('bestaetigt_topf')) {
            mindestensEineEinzelZuweisungBestaetigtTopf = true;
            //console.log(`Slot ${zuweisung} bestätigt.`);
        } else if (status.startsWith('abgelehnt_topf')) {
            alleEinzelZuweisungenBestaetigtTopf = false; // Mindestens eine ist abgelehnt
            //console.log(`Slot ${zuweisung} abgelehnt.`);
        }
    }

    if (!alleEinzelZuweisungenAbgeschlossen) {
        this.Status = 'in_konfliktloesung_topf';
    } else { // Alle Topf-Konflikte für die zugewiesenen Slots sind entschieden
        if (mindestensEineEinzelZuweisungBestaetigtTopf && alleEinzelZuweisungenBestaetigtTopf) {
            // Alle zugewiesenen Slots haben die Topf-Phase positiv durchlaufen.
            // Dies ist der Punkt, an dem man später in die Slot-Konflikt-Prüfung gehen würde.
            this.Status = 'vollstaendig_bestaetigt_topf'; // Neuer Status, um Bereitschaft für Slot-Konflikt anzuzeigen
        } else if (mindestensEineEinzelZuweisungBestaetigtTopf) { // Einige bestätigt, einige abgelehnt
            this.Status = 'teilweise_bestaetigt_topf'; // Neuer Status
        } else { // Keine einzige Zuweisung hat die Topf-Phase überstanden
            this.Status = 'final_abgelehnt';
        }
    }
};

module.exports = mongoose.model('Anfrage', anfrageSchema);