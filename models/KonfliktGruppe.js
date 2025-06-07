// models/KonfliktGruppe.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const konfliktGruppeSchema = new Schema({
    // _id wird automatisch von MongoDB generiert und dient als unsere stabile gruppenId

    gruppenSchluessel: { 
        // Der sortierte, kommaseparierte String der Anfrage-IDs.
        // Dient zur schnellen Identifizierung, ob für eine Anfrage-Kombination schon eine Gruppe existiert.
        type: String, 
        required: true, 
        unique: true, 
        index: true 
    },
    beteiligteAnfragen: [{ 
        type: Schema.Types.ObjectId, 
        ref: 'Anfrage' 
    }],
    konflikteInGruppe: [{ // Referenzen auf die einzelnen KonfliktDokumentation-Objekte
        type: Schema.Types.ObjectId, 
        ref: 'KonfliktDokumentation' 
    }],
    status: {
        type: String,
        required: true,
        enum: [
            'offen',                          // Gruppe wurde neu identifiziert oder ein gelöster Konflikt darin wurde neu aufgerollt
            'in_bearbeitung_verzicht',      // NEU: Die Gruppe wird gerade bzgl. Verzicht/Verschub bearbeitet
            'in_bearbeitung_entgelt',         // Die Gruppe befindet sich im Entgeltvergleich
            'in_bearbeitung_hoechstpreis',    // Die Gruppe befindet sich im Höchstpreisverfahren
            'teilweise_geloest',              // Einige, aber nicht alle Konflikte in der Gruppe sind gelöst
            'vollstaendig_geloest'          // Alle Konflikte in der Gruppe sind gelöst
        ],
        default: 'offen'
    },
    notizen: String // Notizen, die sich auf die gesamte Gruppe beziehen
}, { timestamps: true });

module.exports = mongoose.model('KonfliktGruppe', konfliktGruppeSchema);