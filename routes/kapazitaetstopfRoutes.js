// slot-buchungs-app/routes/kapazitaetstopfRoutes.js
const express = require('express');
const router = express.Router();
const kapazitaetstopfController = require('../controllers/kapazitaetstopfController'); // Erstellen wir als Nächstes

// @route   POST /api/kapazitaetstoepfe
// @desc    Erstellt einen neuen Kapazitätstopf
// @access  Admin (angenommen)
router.post('/', kapazitaetstopfController.createKapazitaetstopf);

// @route   GET /api/kapazitaetstoepfe
// @desc    Ruft alle Kapazitätstöpfe ab
// @access  Public/Admin
router.get('/', kapazitaetstopfController.getAllKapazitaetstoepfe);

// @route   GET /api/kapazitaetstoepfe/:topfId
// @desc    Ruft einen einzelnen Kapazitätstopf anhand seiner ID (_id oder TopfID) ab
// @access  Public/Admin
router.get('/:topfId', kapazitaetstopfController.getKapazitaetstopfById);

// @route   PUT /api/kapazitaetstoepfe/:topfId
// @desc    Aktualisiert einen einzelnen Kapazitätstopf anhand seiner ID (_id oder TopfID)
// @access  Public/Admin
router.put('/:topfId', kapazitaetstopfController.updateKapazitaetstopf);

// @route   DELETE /api/kapazitaetstoepfe/:topfIdOderMongoId
// @desc    Löscht einen Kapazitätstopf
// @access  Admin (angenommen)
router.delete('/:topfIdOderMongoId', kapazitaetstopfController.deleteKapazitaetstopf);




module.exports = router;