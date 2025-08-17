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

// ======================================================
// 1. Das Basis-Schema mit allen GEMEINSAMEN Feldern
// ======================================================
const baseSlotSchema = new Schema({
    SlotID_Sprechend: { type: String, unique: true, sparse: true, index: true }, // Eindeutige, sprechende ID
    Linienbezeichnung: { type: String, trim: true, default: '' }, // optionaler Name der Linie des Slots, führt dann SlotID_Sprechend an.
    von: { type: String, required: true, index: true },
    bis: { type: String, required: true, index: true },
    Abschnitt: { type: String, required: [true, 'Der Abschnitt ist für die Topf-Zuweisung erforderlich.'], index: true }, // für die Zuordnung zu den Kapazizätstöpfen
    VerweisAufTopf: { type: Schema.Types.ObjectId, ref: 'Kapazitaetstopf', default: null, index: true },
    Verkehrstag: { type: String, required: true, enum: ['Mo-Fr', 'Sa+So'], index: true },
    Kalenderwoche: { type: Number, required: true, index: true }, // Globale relative KW
    Grundentgelt: { type: Number, required: true, min: [0, 'Das Grundentgelt darf nicht negativ sein.'] }, // Entgelt für einmalige Nutzung (pro Tag)
    zugewieseneAnfragen: [{ type: Schema.Types.ObjectId, ref: 'Anfrage', default: [] }],
    slotTyp: { 
        type: String, 
        required: true, 
        enum: ['TAG', 'NACHT'] 
    },
}, { 
    timestamps: true,
    // WICHTIG: Der Discriminator-Schlüssel
    discriminatorKey: 'slotTyp' 
});

// Hilfsfunktion zum Formatieren der Zeit für die ID
function formatTimeForID(stunde, minute) {
    return `${String(stunde).padStart(2, '0')}${String(minute).padStart(2, '0')}`;
}

// ANGEPASSTER pre-save Hook, der zwischen TAG und NACHT unterscheidet
baseSlotSchema.pre('save', async function(next) {
    //console.log(this);
    // Prüfe, ob die ID neu generiert werden muss
    if (this.isNew || !this.SlotID_Sprechend || this.isModified('Linienbezeichnung') || this.isModified('von') || this.isModified('bis') || this.isModified('Kalenderwoche') || this.isModified('Verkehrstag') || this.isModified('Abfahrt') || this.isModified('Zeitfenster') || this.isModified('Verkehrsart')) {
        
        const linienPrefix = this.Linienbezeichnung 
            ? `${this.Linienbezeichnung.trim().toUpperCase().replace(/\s+/g, '_')}_` 
            : '';

        if (this.slotTyp === 'TAG') {
            // ----- Logik für TAGES-Slots -----           
            // Sicherheitscheck, da Abfahrt nur bei Tages-Slots existiert
            if (this.Abfahrt) {
                const abfahrtFormatted = formatTimeForID(this.Abfahrt.stunde, this.Abfahrt.minute);
                this.SlotID_Sprechend = `${linienPrefix}SLOT_${this.von}_${this.bis}_KW${this.Kalenderwoche}_${this.Verkehrstag}_${abfahrtFormatted}_${this.Verkehrsart}`;
            }
        } 
        else if (this.slotTyp === 'NACHT') {
            // ----- Logik für NACHT-Slots -----
            // 1. Baue die Basis-ID ohne die laufende Nummer
            const baseId = `NACHT_SLOT_${this.von}_${this.bis}_KW${this.Kalenderwoche}_${this.Verkehrstag}_${this.Zeitfenster}`;

            // 2. Erstelle einen "sicheren" String für die RegExp, indem Sonderzeichen escaped werden
            const escapeRegex = (string) => {
                return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // \$& fügt das gefundene Zeichen nach dem Backslash ein
            };
            const safeBaseIdForRegex = escapeRegex(baseId);
            const regex = new RegExp(`^${safeBaseIdForRegex}_`);
        
            // `this.constructor` verweist auf das korrekte Modell (Slot, TagesSlot oder NachtSlot)
            const existingSlots = await this.constructor.find({ SlotID_Sprechend: regex });

            // 3. Finde die höchste existierende laufende Nummer
            let highestNum = 0;
            if (existingSlots.length > 0) {
                existingSlots.forEach(slot => {
                    const numPart = slot.SlotID_Sprechend.split('_').pop();
                    const num = parseInt(numPart, 10);
                    if (!isNaN(num) && num > highestNum) {
                        highestNum = num;
                    }
                });
            }
            
            // 4. Setze die neue ID mit der nächsthöheren Nummer
            this.SlotID_Sprechend = `${baseId}_${highestNum + 1}`;
        }
    }
    next();
});

baseSlotSchema.pre('deleteOne', { document: true, query: false }, async function(next) {
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

// Erstelle das Basis-Modell
const Slot = mongoose.model('Slot', baseSlotSchema);

// ======================================================
// 2. Das spezialisierte Modell für TAGES-Slots
// ======================================================

// Definiere zuerst das Schema für den Tages-Slot als eigene Konstante
const tagesSlotSchema = new Schema({
    Abfahrt: {
        stunde: { type: Number, required: true, min: 5, max: 22 }, // Gültig von 05:00 bis 22:59
        minute: { type: Number, required: true, min: 0, max: 59 }
    },
    Ankunft: {
        stunde: { type: Number, required: true, min: 0, max: 23 }, // Ankunft kann auch nach 23 Uhr sein
        minute: { type: Number, required: true, min: 0, max: 59 }
    },
    Verkehrsart: {
        type: String,
        required: true,
        enum: ['SPFV', 'SPNV', 'SGV'] // Spezifische Verkehrsart
    }
});

// Die mapAbfahrtstundeToKapazitaetstopfZeitfenster Funktion als statische Methode,
// damit der Controller sie nutzen kann.
tagesSlotSchema.statics.mapAbfahrtstundeToKapazitaetstopfZeitfenster = mapAbfahrtstundeToKapazitaetstopfZeitfenster;


// Virtuelle Methoden für formatierte Zeit (optional, wie vorher)
tagesSlotSchema.methods.getAbfahrtFormatted = function() {
    if (!this.Abfahrt) return '';
    return `${String(this.Abfahrt.stunde).padStart(2, '0')}:${String(this.Abfahrt.minute).padStart(2, '0')}`;
};

tagesSlotSchema.methods.getAnkunftFormatted = function() {
    if (!this.Ankunft) return '';
    return `${String(this.Ankunft.stunde).padStart(2, '0')}:${String(this.Ankunft.minute).padStart(2, '0')}`;
};

// Erstelle das Discriminator-Modell mit dem Schema, das die o.g. Methoden enthält
const TagesSlot = Slot.discriminator('TAG', tagesSlotSchema);



// ======================================================
// 3. Das spezialisierte Modell für NACHT-Slots
// ======================================================
const NachtSlot = Slot.discriminator('NACHT', new Schema({
    Zeitfenster: {
        type: String,
        required: true,
        enum: ['23-01', '01-03', '03-05'] // Nur nächtliche Zeitfenster
    },
    Mindestfahrzeit: { // z.B. in Minuten
        type: Number,
        required: true,
        min: 0
    },
    Maximalfahrzeit: { // z.B. in Minuten
        type: Number,
        required: true,
        min: 0
    },
    Verkehrsart: { // Für Nacht-Slots immer 'ALLE'
        type: String,
        required: true,
        default: 'ALLE',
        enum: ['ALLE']
    }
}));






// Exportiere alle Modelle, damit sie in der Anwendung genutzt werden können
module.exports = {
    Slot,       // Das Basis-Modell für allgemeine Abfragen
    TagesSlot,  // Das Modell zum Erstellen/Abfragen von nur Tages-Slots
    NachtSlot   // Das Modell zum Erstellen/Abfragen von nur Nacht-Slots
};