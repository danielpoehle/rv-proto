// models/Kapazitaetstopf.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Definition der erlaubten Zeitfenster-Strings und ihrer numerischen Startstunden
const zeitfensterOptionen = {
    '05-07': 5, '07-09': 7, '09-11': 9, '11-13': 11,
    '13-15': 13, '15-17': 15, '17-19': 17, '19-21': 19,
    '21-23': 21, '23-01': 23, '01-03': 1, '03-05': 3
};

const kapazitaetstopfSchema = new Schema({
    TopfID: { // Wird jetzt automatisch generiert
        type: String,
        unique: true,
        index: true
    },
    Abschnitt: {
        type: String,
        required: [true, 'Abschnitt ist ein Pflichtfeld.']
    },
    Verkehrsart: {
        type: String,
        required: [true, 'Verkehrsart ist ein Pflichtfeld.'],
        enum: ['SPFV', 'SPNV', 'SGV', 'ALLE']
    },
    ListeDerSlots: [{ type: Schema.Types.ObjectId, ref: 'Slot' }], // Slots, die diesem Topf direkt zugeordnet sind
    maxKapazitaet: { // Maximale Kapazität des Topfes (z.B. Anzahl Züge/Slots)
        type: Number,
        default: 0, // Standardwert, falls nicht anders angegeben
        min: [0, 'Die maxKapazitaet darf nicht negativ sein.']
    },
    Zeitfenster: { // Die String-Repräsentation des Zeitfensters
        type: String,
        required: [true, 'Zeitfenster ist ein Pflichtfeld.'],
        enum: Object.keys(zeitfensterOptionen)
    },
    ZeitfensterStartStunde: { // Die numerische Startstunde für einfache Abfragen
        type: Number,
        required: true, // Wird durch pre-validate hook gesetzt
        enum: Object.values(zeitfensterOptionen),
        index: true
    },
    Kalenderwoche: { // Numerische Kalenderwoche, z.B. 23
        type: Number,
        required: [true, 'Kalenderwoche ist ein Pflichtfeld.'],
        index: true
    },
    Verkehrstag: { // Typ des Verkehrstages, z.B. Mo-Fr
        type: String,
        required: [true, 'Verkehrstag ist ein Pflichtfeld.'],
        enum: ['Mo-Fr', 'Sa+So'],
        index: true
    },
    // Anfragen, die (nach erster Prüfung) diesem Topf aufgrund ihrer Slotwünsche zugeordnet wurden
    ListeDerAnfragen: [{ type: Schema.Types.ObjectId, ref: 'Anfrage' }],
    TopfIDVorgänger: { type: Schema.Types.ObjectId, ref: 'Kapazitaetstopf', default: null },
    TopfIDNachfolger: { type: Schema.Types.ObjectId, ref: 'Kapazitaetstopf', default: null }
}, { timestamps: true });

// Pre-validate Hook, um ZeitfensterStartStunde automatisch zu setzen (aus deinem Modell)
kapazitaetstopfSchema.pre('validate', function(next) {
    if (this.isModified('Zeitfenster') || this.isNew) {
        const numerischerWert = zeitfensterOptionen[this.Zeitfenster];
        if (numerischerWert !== undefined) {
            this.ZeitfensterStartStunde = numerischerWert;
        } else {
            return next(new Error(`Ungültiger Zeitfenster-String: ${this.Zeitfenster}`));
        }
    }
    next();
});

// NEUER Pre-save Hook, um TopfID automatisch zu generieren
kapazitaetstopfSchema.pre('save', function(next) {
    // Generiere die TopfID nur, wenn sie noch nicht existiert (neues Dokument)
    // oder wenn sich eines der relevanten Felder geändert hat.
    if (this.isNew || !this.TopfID || 
        this.isModified('Abschnitt') || 
        this.isModified('Kalenderwoche') || 
        this.isModified('Verkehrsart') || 
        this.isModified('Verkehrstag') ||
        this.isModified('Zeitfenster')) { // Zeitfenster als ID-Bestandteil hinzugefügt
        // Bereinige den Abschnitt für die ID: Leerzeichen -> '-', keine Sonderzeichen außer '-' & '_', Großbuchstaben
        const sanierterAbschnitt = (this.Abschnitt || 'N_A') // Fallback, falls Abschnitt leer ist (sollte durch 'required' nicht passieren)
            .toString()
            .trim()
            .replace(/\s+/g, '-') // Ersetze Leerzeichen durch Bindestriche
            .replace(/[^a-zA-Z0-9-_]/g, '') // Entferne alle Zeichen außer Buchstaben, Zahlen, '-' und '_'
            .toUpperCase();

        const kw = this.Kalenderwoche || 'XX'; // Fallback für KW
        const va = this.Verkehrsart || 'VA'; // Fallback für Verkehrsart
        const vt = (this.Verkehrstag || 'VT').replace('+', 'u'); // Ersetze '+' durch 'u' (z.B. Sa+So -> SauSo)
        // Zeitfenster-String für ID vorbereiten (z.B. "05-07" -> "0507")
        const zf = (this.Zeitfenster || 'ZFXX').replace('-', '');

        this.TopfID = `KT-${sanierterAbschnitt}-KW${kw}-${va}-${vt}-ZF${zf}`;
    }
    next();
});

module.exports = mongoose.model('Kapazitaetstopf', kapazitaetstopfSchema);