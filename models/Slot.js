// models/Slot.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;


function mapAbfahrtstundeToKapazitaetstopfZeitfenster(stunde) {
    if (stunde === undefined || stunde === null || stunde < 0 || stunde > 23) return null;

    if (stunde >= 5 && stunde <= 6) return '05-07';
    if (stunde >= 7 && stunde <= 8) return '07-09';
    if (stunde >= 9 && stunde <= 10) return '09-11';
    if (stunde >= 11 && stunde <= 12) return '11-13';
    if (stunde >= 13 && stunde <= 14) return '13-15';
    if (stunde >= 15 && stunde <= 16) return '15-17';
    if (stunde >= 17 && stunde <= 18) return '17-19';
    if (stunde >= 19 && stunde <= 20) return '19-21';
    if (stunde >= 21 && stunde <= 22) return '21-23';
    if (stunde === 23 || stunde === 0) return '23-01'; // Stunde 0 (Mitternacht) für das 23-01 Fenster
    if (stunde >= 1 && stunde <= 2) return '01-03';
    if (stunde >= 3 && stunde <= 4) return '03-05';
    return null; // Sollte nicht erreicht werden bei validen Stunden 0-23
}

const slotSchema = new Schema({
    SlotID_Sprechend: { type: String, unique: true, sparse: true, index: true }, // Eindeutige, sprechende ID
    von: { type: String, required: true, index: true },
    bis: { type: String, required: true, index: true },
    Abschnitt: { type: String, required: [true, 'Der Abschnitt ist für die Topf-Zuweisung erforderlich.'], index: true }, // für die Zuordnung zu den Kapazizätstöpfen
    Abfahrt: {
        stunde: { type: Number, required: true, min: 0, max: 23 },
        minute: { type: Number, required: true, min: 0, max: 59 }
    },
    Ankunft: {
        stunde: { type: Number, required: true, min: 0, max: 23 },
        minute: { type: Number, required: true, min: 0, max: 59 }
    },
    VerweisAufTopf: { type: Schema.Types.ObjectId, ref: 'Kapazitaetstopf', default: null, index: true },
    Verkehrstag: {
        type: String,
        required: true,
        enum: ['Mo-Fr', 'Sa+So'],
        index: true
    },
    Kalenderwoche: { type: Number, required: true, index: true }, // Globale relative KW
    Grundentgelt: { type: Number, required: true, min: [0, 'Das Grundentgelt darf nicht negativ sein.'] }, // NEU: Entgelt für einmalige Nutzung (pro Tag)
    zugewieseneAnfragen: [{ type: Schema.Types.ObjectId, ref: 'Anfrage', default: [] }],
    Verkehrsart: {
        type: String,
        required: true,
        enum: ['SPFV', 'SPNV', 'SGV'],
        index: true
    }
}, { timestamps: true });


// Hilfsfunktion zum Formatieren der Zeit für die ID
function formatTimeForID(stunde, minute) {
    return `${String(stunde).padStart(2, '0')}${String(minute).padStart(2, '0')}`;
}

slotSchema.pre('save', function(next) {
    // Nur noch SlotID_Sprechend generieren
    if (this.isNew || !this.SlotID_Sprechend || this.isModified('von') || this.isModified('bis') || this.isModified('Kalenderwoche') || this.isModified('Verkehrstag') || this.isModified('Abfahrt') || this.isModified('Verkehrsart')) {
        const formatTimeForID = (stunde, minute) => `${String(stunde).padStart(2, '0')}${String(minute).padStart(2, '0')}`;
        const abfahrtFormatted = formatTimeForID(this.Abfahrt.stunde, this.Abfahrt.minute);
        this.SlotID_Sprechend = `SLOT_${this.von}_${this.bis}_KW${this.Kalenderwoche}_${this.Verkehrstag}_${abfahrtFormatted}_${this.Verkehrsart}`;
    }
    next();
});

slotSchema.pre('deleteOne', { document: true, query: false }, async function(next) {
    const hookName = "[Slot pre('deleteOne') Hook]"; // Für besseres Logging
    console.log(`${hookName} Ausgelöst für Slot ID: ${this._id}, Sprechende ID: ${this.SlotID_Sprechend || 'N/A'}`);
    
    const KapazitaetstopfModel = mongoose.model('Kapazitaetstopf');
    const slotIdBeingDeleted = this._id;
    const topfId = this.VerweisAufTopf;

    if (topfId) {
        console.log(`${hookName} Slot war Kapazitätstopf ${topfId} zugeordnet.`);
        try {
            const topf = await KapazitaetstopfModel.findById(topfId);
            if (topf) {
                console.log(`${hookName} Kapazitätstopf ${topf.TopfID || topf._id} gefunden. Aktuelle ListeDerSlots Länge: ${topf.ListeDerSlots.length}`);
                const initialLength = topf.ListeDerSlots.length;

                topf.ListeDerSlots.pull(slotIdBeingDeleted); // Entfernt alle Instanzen von slotIdBeingDeleted

                if (topf.ListeDerSlots.length < initialLength) {
                    console.log(`${hookName} Slot ${slotIdBeingDeleted} aus ListeDerSlots entfernt. Neue Länge: ${topf.ListeDerSlots.length}`);
                    topf.maxKapazitaet = Math.floor(0.7 * topf.ListeDerSlots.length);
                    
                    // Explizit markieren, dass sich das Array und maxKapazitaet geändert haben
                    topf.markModified('ListeDerSlots');
                    topf.markModified('maxKapazitaet');
                    
                    await topf.save();
                    console.log(`${hookName} Kapazitätstopf ${topf.TopfID || topf._id} erfolgreich aktualisiert. Neue maxKap: ${topf.maxKapazitaet}.`);
                } else {
                    console.warn(`${hookName} Slot ${slotIdBeingDeleted} wurde nicht in ListeDerSlots von Topf ${topf.TopfID || topf._id} gefunden oder pull() hatte keinen Effekt. Liste war: [${topf.ListeDerSlots.map(id=>id.toString()).join(', ')}]`);
                    // Optional: maxKapazitaet trotzdem neu berechnen, falls die Konsistenz Slot->Topf vorher schon gestört war
                    // und dieser Slot fälschlicherweise noch auf den Topf verwies.
                    // Für den Moment belassen wir es dabei, nur zu speichern, wenn die Liste sich wirklich ändert.
                }
            } else {
                console.warn(`${hookName} Kapazitätstopf mit ID ${topfId} (referenziert von Slot ${this.SlotID_Sprechend || this._id}) wurde nicht in der DB gefunden.`);
            }
        } catch (err) {
            console.error(`${hookName} Fehler beim Aktualisieren des Kapazitätstopfes ${topfId} für gelöschten Slot ${this._id}:`, err);
            // Fehler an die aufrufende Operation weitergeben, damit das Löschen des Slots fehlschlägt
            return next(err); 
        }
    } else {
        console.log(`${hookName} Slot ${this.SlotID_Sprechend || this._id} hatte keinen VerweisAufTopf, keine Aktion für Kapazitätstopf nötig.`);
    }
    next(); // Alles ok oder Fehler wurde nicht weitergegeben
});

// Die mapAbfahrtstundeToKapazitaetstopfZeitfenster Funktion als statische Methode oder Export,
// damit der Controller sie nutzen kann (oder sie wird im Controller direkt definiert).
slotSchema.statics.mapAbfahrtstundeToKapazitaetstopfZeitfenster = mapAbfahrtstundeToKapazitaetstopfZeitfenster;


// Virtuelle Methoden für formatierte Zeit (optional, wie vorher)
slotSchema.methods.getAbfahrtFormatted = function() {
    return `${String(this.Abfahrt.stunde).padStart(2, '0')}:${String(this.Abfahrt.minute).padStart(2, '0')}`;
};

slotSchema.methods.getAnkunftFormatted = function() {
    return `${String(this.Ankunft.stunde).padStart(2, '0')}:${String(this.Ankunft.minute).padStart(2, '0')}`;
};

module.exports = mongoose.model('Slot', slotSchema);