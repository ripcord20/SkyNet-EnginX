const { User, Role, Permission, RolePermission } = require('../models');
const { Op } = require('sequelize');
const { paginateResponse } = require('../utils/helpers');

class UserController {
  // List users
  async index(req, res) {
    try {
      const { page = 1, limit = 20, search, role } = req.query;
      const where = {};
      if (search) {
        where[Op.or] = [
          { name: { [Op.like]: `%${search}%` } },
          { email: { [Op.like]: `%${search}%` } }
        ];
      }
      if (role) where.role_id = role;

      const offset = (page - 1) * limit;
      const { count, rows } = await User.findAndCountAll({
        where,
        include: [{ model: Role, as: 'role' }],
        offset,
        limit: parseInt(limit),
        order: [['created_at', 'DESC']]
      });

      res.json({ success: true, ...paginateResponse(rows, count, page, limit) });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // Create user
  async create(req, res) {
    try {
      const { name, email, password, role_id, phone } = req.body;
      const user = await User.create({ name, email, password, role_id, phone });
      const fullUser = await User.findByPk(user.id, {
        include: [{ model: Role, as: 'role' }]
      });
      res.status(201).json({ success: true, data: fullUser });
    } catch (error) {
      res.status(400).json({ success: false, message: error.message });
    }
  }

  // Get user
  async show(req, res) {
    try {
      const user = await User.findByPk(req.params.id, {
        include: [{ model: Role, as: 'role' }]
      });
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });
      res.json({ success: true, data: user });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // Update user
  async update(req, res) {
    try {
      const user = await User.findByPk(req.params.id);
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });

      const { name, email, role_id, phone, is_active, password } = req.body;

      // Build payload: hanya include field yang relevan.
      // PENTING: password hanya di-include kalau diisi (non-empty), supaya admin
      // bisa edit field lain tanpa harus re-input password lama. Hash dilakukan
      // otomatis di hook `beforeUpdate` di User model (lihat models/User.js).
      const payload = { name, email, role_id, phone, is_active };
      if (password && String(password).trim()) {
        const pwd = String(password);
        if (pwd.length < 6) {
          return res.status(400).json({ success: false, message: 'Password minimal 6 karakter' });
        }
        payload.password = pwd; // raw — hook beforeUpdate akan bcrypt.hash secara otomatis
      }

      await user.update(payload);

      const updated = await User.findByPk(user.id, {
        include: [{ model: Role, as: 'role' }]
      });
      res.json({ success: true, data: updated });
    } catch (error) {
      res.status(400).json({ success: false, message: error.message });
    }
  }

  // Delete user
  async destroy(req, res) {
    try {
      const user = await User.findByPk(req.params.id);
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });
      if (user.id === req.user.id) {
        return res.status(400).json({ success: false, message: 'Cannot delete yourself' });
      }
      await user.destroy();
      res.json({ success: true, message: 'User deleted' });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // ===== Role Management =====
  async getRoles(req, res) {
    try {
      const roles = await Role.findAll({
        include: [{ model: Permission, as: 'permissions', through: { attributes: [] } }],
        order: [['id', 'ASC']]
      });
      res.json({ success: true, data: roles });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async createRole(req, res) {
    try {
      const { name, display_name, description, permissions } = req.body;
      const role = await Role.create({ name, display_name, description });
      if (permissions && permissions.length > 0) {
        const rolePerms = permissions.map(pid => ({ role_id: role.id, permission_id: pid }));
        await RolePermission.bulkCreate(rolePerms);
      }
      const full = await Role.findByPk(role.id, {
        include: [{ model: Permission, as: 'permissions', through: { attributes: [] } }]
      });
      res.status(201).json({ success: true, data: full });
    } catch (error) {
      res.status(400).json({ success: false, message: error.message });
    }
  }

  async updateRole(req, res) {
    try {
      const role = await Role.findByPk(req.params.id);
      if (!role) return res.status(404).json({ success: false, message: 'Role not found' });
      if (role.is_system) return res.status(400).json({ success: false, message: 'Cannot edit system role' });

      const { display_name, description, permissions } = req.body;
      await role.update({ display_name, description });

      if (permissions) {
        await RolePermission.destroy({ where: { role_id: role.id } });
        const rolePerms = permissions.map(pid => ({ role_id: role.id, permission_id: pid }));
        await RolePermission.bulkCreate(rolePerms);
      }

      const full = await Role.findByPk(role.id, {
        include: [{ model: Permission, as: 'permissions', through: { attributes: [] } }]
      });
      res.json({ success: true, data: full });
    } catch (error) {
      res.status(400).json({ success: false, message: error.message });
    }
  }

  async deleteRole(req, res) {
    try {
      const role = await Role.findByPk(req.params.id);
      if (!role) return res.status(404).json({ success: false, message: 'Role not found' });
      if (role.is_system) return res.status(400).json({ success: false, message: 'Cannot delete system role' });

      const userCount = await User.count({ where: { role_id: role.id } });
      if (userCount > 0) {
        return res.status(400).json({ success: false, message: 'Role has assigned users' });
      }

      await RolePermission.destroy({ where: { role_id: role.id } });
      await role.destroy();
      res.json({ success: true, message: 'Role deleted' });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getPermissions(req, res) {
    try {
      const permissions = await Permission.findAll({ order: [['module', 'ASC'], ['name', 'ASC']] });
      res.json({ success: true, data: permissions });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

module.exports = new UserController();