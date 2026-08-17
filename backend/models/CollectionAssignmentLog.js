const { DataTypes } = require('sequelize');

/**
 * CollectionAssignmentLog — jejak audit penugasan (reassign) collection.
 *
 * Setiap kali admin memindahkan tugas penagihan dari satu kolektor ke
 * kolektor lain (atau menugaskan dari pending), satu baris dicatat di sini
 * supaya ada riwayat: siapa memindahkan, dari siapa, ke siapa, kapan, dan
 * alasannya. Dipakai untuk pertanggungjawaban & menghindari sengketa.
 *
 * action:
 *   assign    → dari pending/null ke seorang kolektor
 *   reassign  → dari kolektor A ke kolektor B
 *   unassign  → kolektor dilepas (kembali ke pending)
 */
module.exports = (sequelize) => {
  const CollectionAssignmentLog = sequelize.define('CollectionAssignmentLog', {
    id:            { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    assignment_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    action:        { type: DataTypes.ENUM('assign', 'reassign', 'unassign'), allowNull: false, defaultValue: 'reassign' },
    from_collector_id: { type: DataTypes.INTEGER, allowNull: true },
    to_collector_id:   { type: DataTypes.INTEGER, allowNull: true },
    changed_by:    { type: DataTypes.INTEGER, allowNull: true, comment: 'User (admin) yang melakukan perubahan' },
    reason:        { type: DataTypes.STRING(255), allowNull: true },
  }, {
    tableName: 'collection_assignment_logs',
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['assignment_id'] },
      { fields: ['to_collector_id'] },
      { fields: ['changed_by'] },
    ]
  });

  return CollectionAssignmentLog;
};
