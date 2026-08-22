/**
 * patch: backend/models/User.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Tambahkan 3 field baru di bawah field `refresh_token`:
 *   - is_demo
 *   - demo_expires_at
 *   - demo_extended
 *
 * File di bawah adalah VERSI LENGKAP User.js setelah patch. Ganti total isi
 * file backend/models/User.js dengan ini.
 *
 * Kalau Anda HANYA pakai MODE A (shared demo), tidak perlu ubah file ini.
 */

const { DataTypes } = require('sequelize');
const bcrypt = require('bcryptjs');

module.exports = (sequelize) => {
  const User = sequelize.define('User', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    uuid: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      unique: true
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false
    },
    email: {
      type: DataTypes.STRING(150),
      allowNull: false,
      unique: true,
      validate: { isEmail: true }
    },
    password: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    role_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'roles', key: 'id' }
    },
    avatar: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    phone: {
      type: DataTypes.STRING(20),
      allowNull: true
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    // ─── Demo account fields (MODE B — ephemeral) ────────────────────────────
    is_demo: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    demo_expires_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    demo_extended: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    // ─────────────────────────────────────────────────────────────────────────
    last_login: {
      type: DataTypes.DATE,
      allowNull: true
    },
    refresh_token: {
      type: DataTypes.TEXT,
      allowNull: true
    }
  }, {
    tableName: 'users',
    timestamps: true,
    hooks: {
      beforeCreate: async (user) => {
        if (user.password) {
          user.password = await bcrypt.hash(user.password, 12);
        }
      },
      beforeUpdate: async (user) => {
        if (user.changed('password')) {
          user.password = await bcrypt.hash(user.password, 12);
        }
      }
    }
  });

  User.prototype.validatePassword = async function(password) {
    return bcrypt.compare(password, this.password);
  };

  User.prototype.toJSON = function() {
    const values = Object.assign({}, this.get());
    delete values.password;
    delete values.refresh_token;
    return values;
  };

  return User;
};
