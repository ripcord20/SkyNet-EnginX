const { sequelize } = require('../models');

class DashboardLayoutController {
  // Get user's dashboard layout preferences
  async getLayout(req, res) {
    try {
      const userId = req.user.id;
      
      // Try to get from database
      const [result] = await sequelize.query(
        `SELECT layout_config FROM user_dashboard_layouts WHERE user_id = ?`,
        { replacements: [userId], type: sequelize.QueryTypes.SELECT }
      );

      if (result && result.layout_config) {
        return res.json({
          success: true,
          data: JSON.parse(result.layout_config)
        });
      }

      // Return default layout
      const defaultLayout = {
        widgets: [
          { id: 'summary-cards', visible: true, order: 1 },
          { id: 'traffic-activity', visible: true, order: 2 },
          { id: 'top-customers', visible: true, order: 3 },
          { id: 'network-uptime', visible: true, order: 4 },
          { id: 'ticket-stats', visible: true, order: 5 },
          { id: 'bandwidth-trends', visible: true, order: 6 },
          { id: 'customer-growth', visible: true, order: 7 },
          { id: 'revenue-forecast', visible: true, order: 8 },
          { id: 'device-billing', visible: true, order: 9 }
        ]
      };

      res.json({
        success: true,
        data: defaultLayout
      });
    } catch (error) {
      console.error('Error getting dashboard layout:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // Save user's dashboard layout preferences
  async saveLayout(req, res) {
    try {
      const userId = req.user.id;
      const { widgets } = req.body;

      if (!widgets || !Array.isArray(widgets)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid layout data'
        });
      }

      const layoutConfig = JSON.stringify({ widgets });

      // Upsert layout config
      await sequelize.query(
        `INSERT INTO user_dashboard_layouts (user_id, layout_config, updated_at)
         VALUES (?, ?, NOW())
         ON DUPLICATE KEY UPDATE layout_config = ?, updated_at = NOW()`,
        { replacements: [userId, layoutConfig, layoutConfig] }
      );

      res.json({
        success: true,
        message: 'Dashboard layout saved successfully'
      });
    } catch (error) {
      console.error('Error saving dashboard layout:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // Reset to default layout
  async resetLayout(req, res) {
    try {
      const userId = req.user.id;

      await sequelize.query(
        `DELETE FROM user_dashboard_layouts WHERE user_id = ?`,
        { replacements: [userId] }
      );

      res.json({
        success: true,
        message: 'Dashboard layout reset to default'
      });
    } catch (error) {
      console.error('Error resetting dashboard layout:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

module.exports = new DashboardLayoutController();
