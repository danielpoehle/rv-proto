const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const evuReihungSchema = new Schema({
    evu: { type: String, required: true },
    anfrageIds: [{ type: Schema.Types.ObjectId, ref: 'Anfrage' }]
}, { _id: false });

const konfliktDokumentationSchema = new Schema({
    beteiligteAnfragen: [{ type: Schema.Types.ObjectId, ref: 'Anfrage', required: true }],
    zugewieseneAnfragen: [{ type: Schema.Types.ObjectId, ref: 'Anfrage' }],
    abgelehnteAnfragenEntgeltvergleich: [{ type: Schema.Types.ObjectId, ref: 'Anfrage' }],
    abgelehnteAnfragenHoechstpreis: [{ type: Schema.Types.ObjectId, ref: 'Anfrage' }],
    abgelehnteAnfragenMarktanteil: [{ type: Schema.Types.ObjectId, ref: 'Anfrage' }],
    evuReihungen: [evuReihungSchema],
    ReihungEntgelt: [{
        anfrage: { type: Schema.Types.ObjectId, ref: 'Anfrage' },
        entgelt: Number,
        rang: Number
    }],
    ListeGeboteHoechstpreis: [{
        anfrage: { type: Schema.Types.ObjectId, ref: 'Anfrage' },
        gebot: Number
    }],
    ListeAnfragenMitVerzicht: [{ type: Schema.Types.ObjectId, ref: 'Anfrage' }],
    ListeAnfragenVerschubKoordination: [{
        anfrage: { type: Schema.Types.ObjectId, ref: 'Anfrage' },
        details: String // z.B. neue Slot-Zuweisung, geänderte Zeiten
    }],
    erstellungsdatum: { type: Date, default: Date.now },
    abschlussdatum: { type: Date },
    konfliktTyp: {
        type: String,
        required: true,
        enum: ['KAPAZITAETSTOPF', 'SLOT'] // Wir erzwingen, dass nur diese beiden Werte möglich sind
    },
    status: {
    type: String,
    required: true,
    enum: [
        'offen',                        // Konflikt erkannt, noch keine Bearbeitung
        'in_bearbeitung',               // Allgemeine Bearbeitung (z.B. nach Verzicht/Verschub-Phase)
        'in_bearbeitung_entgelt',       // Bereit für/in Entgeltvergleich
        'in_bearbeitung_hoechstpreis',  // Spezifisch: Höchstpreisverfahren läuft/wird erwartet
        'geloest',                      // Konflikt erfolgreich aufgelöst
        'eskaliert'                     // Konflikt konnte nicht gelöst werden, Eskalation nötig
    ],
    default: 'offen'
},
    notizen: String,
    ausloesenderKapazitaetstopf: {
        type: Schema.Types.ObjectId,
        ref: 'Kapazitaetstopf',
        // 'required' ist jetzt eine Funktion!
        // Dieses Feld ist nur erforderlich, wenn 'konfliktTyp' den Wert 'KAPAZITAETSTOPF' hat.
        required: function() { return this.konfliktTyp === 'KAPAZITAETSTOPF'; }
    },
    ausloesenderSlot: {
        type: Schema.Types.ObjectId,
        ref: 'Slot',
        // 'required' ist jetzt eine Funktion!
        // Dieses Feld ist nur erforderlich, wenn 'konfliktTyp' den Wert 'SLOT' hat.
        required: function() { return this.konfliktTyp === 'SLOT'; }
    }
}, { timestamps: true });

module.exports = mongoose.model('KonfliktDokumentation', konfliktDokumentationSchema);