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
            'wartet_konflikt_topf',             // Aktiv im Topf-Konflikt, wartet auf Phase 1 Verzicht / Zuweisung
            'wartet_entgeltentscheidung_topf',  // Aktiv im Topf-Konflikt, wartet auf Phase 2 Entgelt-basierte Entscheidung
            'wartet_hoechstpreis_topf',         // Aktiv im Topf-Konflikt, wartet auf Phase 3 Höchstpreis-Entscheidung
            'bestaetigt_topf',                  // Hat Kapazität im Topf-Konflikt erhalten (allgemein oder nach Verzicht)
            'bestaetigt_topf_entgelt',          // Im Topf-Konflikt durch Entgelt zugewiesen
            'bestaetigt_topf_hoechstpreis',     // Im Topf-Konflikt durch Höchstpreis zugewiesen
            'abgelehnt_topf_verzichtet',        // Für diesen Topf-Konflikt verzichtet (Anfrage hat verzichtet)
            'abgelehnt_topf_verschoben',        // Slot wird nach Topf-Koordinierung nicht mehr benötigt, da verschoben
            'abgelehnt_topf_entgelt',           // Im Topf-Konflikt wegen Entgelt abgelehnt
            'abgelehnt_topf_marktanteil',       // Im Topf-Konflikt wegen mehr als 80% Marktanteil der 70% RV-Kapazität abgelehnt
            'abgelehnt_topf_hoechstpreis',      // Im Topf-Konflikt bei Höchstpreis unterlegen
            'abgelehnt_topf_hoechstpreis_ungueltig', // im Topf Höchstpreisverfahren ungültiges Gebot abgegeben
            'abgelehnt_topf_hoechstpreis_kein_gebot', //im Topf Höchstpreisverfahren kein Gebot abgegeben
            'wartet_konflikt_slot',             // Aktiv im Slot-Konflikt, wartet auf Phase 1 Verzicht / Zuweisung
            'wartet_entgeltentscheidung_slot',  // Aktiv im Slot-Konflikt, wartet auf Phase 2 Entgelt-basierte Entscheidung
            'wartet_hoechstpreis_slot',         // Aktiv im Slot-Konflikt, wartet auf Phase 3 Höchstpreis-Entscheidung
            'bestaetigt_slot',                  // Hat Kapazität im Slot-Konflikt erhalten (allgemein oder nach Verzicht)
            'bestaetigt_slot_entgelt',          // Im Slot-Konflikt durch Entgelt zugewiesen
            'bestaetigt_slot_hoechstpreis',     // Im Slot-Konflikt durch Höchstpreis zugewiesen
            'abgelehnt_slot_verzichtet',        // Für diesen Slot-Konflikt verzichtet (Anfrage hat verzichtet)
            'abgelehnt_slot_verschoben',        // Slot wird nach Slot-Koordinierung nicht mehr benötigt, da verschoben
            'abgelehnt_slot_entgelt',           // Im Slot-Konflikt wegen Entgelt abgelehnt
            'abgelehnt_slot_hoechstpreis',      // Im Slot-Konflikt bei Höchstpreis unterlegen
            'abgelehnt_slot_hoechstpreis_ungueltig', // im Slot Höchstpreisverfahren ungültiges Gebot abgegeben
            'abgelehnt_slot_hoechstpreis_kein_gebot', //im Slot Höchstpreisverfahren kein Gebot abgegeben
            'bestaetigt_slot_nachgerückt',      // Slot konnte im Nachrückerverfahren zugewiesen werden
        ],
        default: 'initial_in_konfliktpruefung_topf'
    },
    finalerTopfStatus: {
        type: String,
        required: true,
        enum: [
            'entscheidung_ausstehend',          // Im Topf-Konflikt noch nicht final entschieden
            'bestaetigt_topf_entgelt',          // Im Topf-Konflikt durch Entgelt zugewiesen
            'bestaetigt_topf_hoechstpreis',     // Im Topf-Konflikt durch Höchstpreis zugewiesen
            'abgelehnt_topf_verzichtet',        // Für diesen Topf-Konflikt verzichtet (Anfrage hat verzichtet)
            'abgelehnt_topf_verschoben',        // Slot wird nach Topf-Koordinierung nicht mehr benötigt, da verschoben
            'abgelehnt_topf_entgelt',           // Im Topf-Konflikt wegen Entgelt abgelehnt
            'abgelehnt_topf_marktanteil',       // Im Topf-Konflikt wegen mehr als 80% Marktanteil der 70% RV-Kapazität abgelehnt
            'abgelehnt_topf_hoechstpreis',      // Im Topf-Konflikt bei Höchstpreis unterlegen
            'abgelehnt_topf_hoechstpreis_ungueltig', // im Topf Höchstpreisverfahren ungültiges Gebot abgegeben
            'abgelehnt_topf_hoechstpreis_kein_gebot', //im Topf Höchstpreisverfahren kein Gebot abgegeben            
        ],
        default: 'entscheidung_ausstehend'
    },
    topfKonfliktDoku: { // Verweis auf das Konfliktdokument, falls diese Zuweisung in einem Topf-Konflikt ist
        type: Schema.Types.ObjectId,
        ref: 'KonfliktDokumentation',
        default: null
    },
    slotKonfliktDoku: { // Verweis auf das Konfliktdokument, falls diese Zuweisung in einem Slot-Konflikt ist
        type: Schema.Types.ObjectId,
        ref: 'KonfliktDokumentation',
        default: null
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
            'in_konfliktpruefung',      // Anfrage muss noch auf Konflikte bei Töpfen geprüft werden
            'in_konfliktloesung_topf',  // Mindestens ein zugewiesener Slot ist Teil eines Topf-Konflikts
            'vollstaendig_bestaetigt_topf', // alle Topf-Konflikte gewonnen, Bereitschaft für Slot-Konflikte 
            'teilweise_bestaetigt_topf', // nicht alle Topf-Konflikte gewonnen aber fertig, Bereitschaft für Slot-Konflikte
            'in_konfliktloesung_slot', //  Mindestens ein Slot ist im Slot-Level-Konflikt
            'teilweise_final_bestaetigt',// Einige Slot-Zuweisungen sind final bestätigt, andere nicht/abgelehnt
            'vollstaendig_final_bestaetigt',// Alle gewünschten Slot-Zuweisungen final bestätigt
            'final_abgelehnt',          // Keine Slot-Zuweisungen konnten final bestätigt werden
            'storniert_nutzer',         // Nutzer hat storniert (könnte ein neuer Status sein)
            'fehlende_Plausi',         // Nutzer hat nicht rechtzeitig oder nicht korrekt plausibilisiert
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
    // Diese Status werden extern gesetzt und von dieser Logik nicht überschrieben.
    
    
    // Fall: Keine zugewiesenen Slots mehr, aber es waren welche gewünscht -> final abgelehnt
    if (this.ZugewieseneSlots.length === 0) {
        if (this.ListeGewuenschterSlotAbschnitte.length > 0) {
            this.Status = 'final_abgelehnt';
        }
        return;
    }

    const einzelStatus = this.ZugewieseneSlots.map(z => z.statusEinzelzuweisung);
    //console.log(einzelStatus);

    // --- Definitionen basierend auf deinen Regeln ---
    const hatSlotLevelKonflikt = einzelStatus.some(s => s.startsWith('wartet_') && s.endsWith('_slot'));
    const hatTopfLevelKonflikt = einzelStatus.some(s => s.startsWith('wartet_') && s.endsWith('_topf'));
    const alleTopfKonflikteEntschieden = !einzelStatus.some(s => s === 'initial_in_konfliktpruefung_topf' || (s.startsWith('wartet_') && s.endsWith('_topf')));
    const alleFinalEntschieden = !einzelStatus.some(s => !s.startsWith('bestaetigt_slot') && !s.startsWith('abgelehnt'));

    const hatBestaetigteTopfSlots = einzelStatus.some(s => s.startsWith('bestaetigt_topf'));
    const hatAbgelehnteTopfSlots = einzelStatus.some(s => s.startsWith('abgelehnt_topf'));

    const hatFinaleBestaetigteSlots = einzelStatus.some(s => s.startsWith('bestaetigt_slot'));
    const hatFinaleAbgelehnteSlots = einzelStatus.some(s => s.startsWith('abgelehnt')); // deckt _topf und _slot ab
    
    // console.log(`hatSlotLevelKonflikt ${hatSlotLevelKonflikt} hatTopfLevelKonflikt ${hatTopfLevelKonflikt}`);
    //console.log(`alleTopfKonflikteEntschieden ${alleTopfKonflikteEntschieden} alleFinalEntschieden ${alleFinalEntschieden} `);
    
    // --- Logik zur Status-Setzung (mit Priorität von spezifisch zu allgemein) ---
    if (hatSlotLevelKonflikt) {
        this.Status = 'in_konfliktloesung_slot';
    } 
    else if (hatTopfLevelKonflikt) {
        this.Status = 'in_konfliktloesung_topf';
    }
    else if (alleTopfKonflikteEntschieden) {
        // --- Slot-Level-Ergebnisse (später) oder Finale Ergebnisse nach Topf-Phase ---

        // Logik für FINALE Ergebnisse (wenn alle Slot-Konflikte auch durch sind)
        if (alleFinalEntschieden) {
            if (hatFinaleBestaetigteSlots && !hatFinaleAbgelehnteSlots) {
                this.Status = 'vollstaendig_final_bestaetigt';
            } else if (hatFinaleBestaetigteSlots && hatFinaleAbgelehnteSlots) {
                this.Status = 'teilweise_final_bestaetigt';
            } else if (!hatFinaleBestaetigteSlots && hatFinaleAbgelehnteSlots) {
                this.Status = 'final_abgelehnt';
            }
        } 
        // Logik für Zwischenergebnisse NACH der Topf-Konfliktphase
        else {
            if (hatBestaetigteTopfSlots && !hatAbgelehnteTopfSlots) {
                this.Status = 'vollstaendig_bestaetigt_topf';
            } else if (hatBestaetigteTopfSlots && hatAbgelehnteTopfSlots) {
                this.Status = 'teilweise_bestaetigt_topf';
            } else if (!hatBestaetigteTopfSlots && hatAbgelehnteTopfSlots) {
                this.Status = 'final_abgelehnt'; // Wenn nach Topf-Phase nichts mehr übrig ist
            }
        }
    }
    else if (einzelStatus.every(s => s === 'initial_in_konfliktpruefung_topf')) {
        this.Status = 'in_konfliktpruefung';
    }
    // Fallback, falls keine Regel zutrifft
    else {
        const externGesetzteStatus = [
            'eingegangen', 'validiert', 'ungueltig', 'in_zuordnung', 
            'zuordnung_fehlgeschlagen', 'storniert_nutzer', 'fehlende_Plausi', 'storniert_system'
        ];
        if (externGesetzteStatus.includes(this.Status)) {
            return; // Nichts tun, wenn Status extern verwaltet wird.
        }
    }
};

module.exports = mongoose.model('Anfrage', anfrageSchema);