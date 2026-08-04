module.exports = {
  async checkRole() {
    return { isModerator: false, isAdmin: false }
  },
  async canManageGroupSetting() {
    return true
  },
}
