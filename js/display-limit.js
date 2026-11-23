const DisplayLimit = {
  isValid(value) {
    return Number.isInteger(value) && value >= 10 && value <= 500;
  },

  fromStorage(value) {
    const limit = typeof value === "string" ? Number(value) : value;
    return this.isValid(limit) ? limit : 50;
  }
};
