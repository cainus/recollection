var _ = require("lodash");
var mongoObjectID = require("mongodb").ObjectID;
var async = require("async");
var Schema = require('mongo-json-schema');


/*
  This base model connects to the default mongo database instance.
  If the user wishes to connect to another database they should
  pass in another database instance
 */

var BaseModel = (function() {
  var InvalidMongoIdError, DuplicateKeyError, NotFoundError, indices;

  function BaseModel(collectionName, schema, overrideDatabase) {
    if (!collectionName) {
      throw new Error('collectionName cannot be null');
    }
    this.__collectionName = collectionName;
    schema = schema || {};
    if (schema) {
      this.jsonSchema = Schema(schema, {name : this.__collectionName});
    }
    this.outputFormatter(function(doc){
      return doc;
    });
    if (overrideDatabase) {
      this.overrideDatabase = overrideDatabase;
    }
  }

  BaseModel.prototype.outputFormatter = function(f) {
    var that = this;
    this.__outputFormatter = function(obj){
      if (Array.isArray(obj)){
        return obj.map(function(item){
          item = that.jsonSchema.idsToStrings(item);
          return f(item);
        });
      }
      var stringy = that.jsonSchema.idsToStrings(obj);
      return f(stringy);
    };
  };

  BaseModel.prototype.indices = indices = function(indices) {
    var that = this;
    var index, options;
    indices.forEach(function(entry){
      if (entry.index && entry.options){
        index = entry.index;
        options = entry.options || {};
      } else {
        index = entry;
        options = {};
      }

      that.overrideDatabase.ensureIndex(that.__collectionName, index, options, function(err){
        if (err){
          console.error("Error (2) insuring index for #{@__collectionName}", err);
        }
      });
    });
  };

  BaseModel.prototype.indexes = indices;

  BaseModel.prototype.ObjectID = function(str) {
    return new mongoObjectID(str.toString());
  };

  BaseModel.prototype.ObjectId = function(str) {
    return new mongoObjectID(str.toString());
  };

  BaseModel.oidTest = function(name) {
    return oidTest;
  };

  BaseModel.prototype.collection = function(cb) {
    if (!this.overrideDatabase) {
      console.log("Error fetching database for " + this.__collectionName);
      return cb(new Error("error fetching database"));
    }
    return cb(null, this.overrideDatabase.collection(this.__collectionName));
  };

  BaseModel.prototype.database = function(db){
    this.overrideDatabase = db;
  };

  BaseModel.prototype.create = function(toInsert, cb) {
    var arrayInput, ex, outputFormatter, schema;
    var that = this;
    schema = this.jsonSchema;
    outputFormatter = this.__outputFormatter;
    if (!schema) {
      return this.oldCreate(toInsert, cb);
    }
    arrayInput = _.isArray(toInsert);
    if (arrayInput) {
      try {
        toInsert.forEach((function(_this) {
          return function(item) {
            return schema.validate(item);
          };
        })(this));
      } catch (_error) {
        ex = _error;
        return cb(ex);
      }
      toInsert = toInsert.map(function(item) {
        return schema.stringsToIds(item);
      });
    } else {
      try {
        schema.validate(toInsert);
      } catch (_error) {
        ex = _error;
        return cb(ex);
      }
      toInsert = schema.stringsToIds(toInsert);
    }
    return this.collection(function(err, collection) {
      if (err) {
        return cb(err);
      }
      return collection.insert(toInsert, {
        j: true,
        getLastError: 1,
        safe: true
      }, function(err, result) {
        if (err) {
          if (/duplicate key error/.test(err.message)){
              return cb(DuplicateKeyError({
                message : err.message,
                doc: toInsert,
                collection: that.__collectionName
              }));
          }
          return cb(err);
        }
        return process.nextTick(function() {
          if (schema && result) {
            if (arrayInput) {
              result = result.map(function(doc) {
                return schema.idsToStrings(doc);
              });
            } else {
              result = schema.idsToStrings(result[0]);
            }
          }
          result = outputFormatter(result);
          return cb(err, result);
        });
      });
    });
  };

  /*
    New create that simply inserts whats passed to it into mongo.
    Transitioning over to this method. Only Messages model uses
    this for now.
   */

  BaseModel.prototype.createWithNoValidation = function(obj, cb) {
    return this.collection(function(err, collection) {
      if (err) {
        return cb(err);
      }
      return collection.insert(obj, {
        j: true,
        getLastError: 1,
        safe: true
      }, function(err, result) {
        return process.nextTick(function() {
          if (_.isArray(result)) {
            result = result.shift();
          }
          return cb(err, result);
        });
      });
    });
  };

  // ensure() is basically findOrCreate()
  // @query : a partial doc to identify qualities that must exist
  // @additional : (optional) if the doc doesn't exist, these properties
  // get merged before the doc gets created.

  BaseModel.prototype.ensure = function(query, additional, cb) {
    var err, ex, schema, _id;
    if (arguments.length == 2){
      cb = additional;
      additional = {};
    }
    if (!_.isFunction(cb)){
      throw new Error("cb must be a function");
    }
    var doc = _.defaults(query, additional);
    schema = this.jsonSchema;
    try {
      schema.partialValidate(doc);
    } catch (_error) {
      ex = _error;
      return cb(ex);
    }
    doc = schema.stringsToIds(doc);
    var _this = this;
    this.collection(function(err, collection) {
      if (err) {
        return cb(err);
      }
      var sort = [['_id', 'asc']];
      var options = {
        journal: true,
        getLastError: 1,
        'new': true,
        upsert : true
      };
      return collection.findAndModify(query, sort, doc, options, function(err, result) {
        return process.nextTick(function() {
          if (err) {
            return cb(err);
          }
          if (!result) {
            err = new Error("ensure failed for an unknown reason");
            err.collection = _this.__collectionName;
            return cb(err);
          }
          if (schema) {
            result = schema.idsToStrings(result);
          }
          return cb(null, result);
        });
      });
    });
  };
  // @query : a query to identify the doc to update if it exists
  // @update : if the query finds something it gets updated to this document.  if it
  // doesn't find anything, this document gets inserted.
  // NOTE: the entire document is replaced!
  BaseModel.prototype.upsert = function(query, update, cb) {
    var err, ex, schema, _id;
    schema = this.jsonSchema;
    try {
      schema.partialValidate(update);
    } catch (_error) {
      ex = _error;
      return cb(ex);
    }
    update = schema.stringsToIds(update);
    var _this = this;
    this.collection(function(err, collection) {
      if (err) {
        return cb(err);
      }
      var options = {
        multi: false,
        getLastError: 1,
        upsert: true
      };
      return collection.update(query, update, options, function(err, result) {
        return process.nextTick(function() {
          if (err) {
            return cb(err);
          }
          if (!result) {
            err = new Error("upsert failed for an unknown reason");
            err.collection = _this.__collectionName;
            return cb(err);
          }
          if (schema) {
            update = schema.idsToStrings(update);
          }
          return cb(null, update);
        });
      });
    });
  };

  BaseModel.prototype.update = function(toUpdate, options, cb) {
    var err, ex, schema, _id;
    schema = this.jsonSchema;
    if (_.isFunction(options)) {
      cb = options;
      options = {};
    }
    _id = toUpdate._id;
    if (!_id) {
      err = new Error("No _id parameter supplied with object to update");
      err.collection = this.__collectionName;
      return cb(err);
    }
    try {
      _id = this.ObjectID(_id);
    } catch (_error) {
      ex = _error;
      return cb(ex);
    }
    toUpdate = _.omit(toUpdate, "_id");
    try {
      schema.partialValidate(toUpdate);
    } catch (_error) {
      ex = _error;
      return cb(ex);
    }
    toUpdate = schema.stringsToIds(toUpdate);
    return this.collection((function(_this) {
      return function(err, collection) {
        if (err) {
          return cb(err);
        }
        return collection.findAndModify({
          _id: _id
        }, [['_id', 'asc']], {
          $set: toUpdate
        }, _.extend({
          journal: true,
          getLastError: 1,
          "new": true
        }, options), function(err, result) {
          return process.nextTick(function() {
            if (err) {
              return cb(err);
            } else if (!result) {
              err = new Error("" + _this.__collectionName + " with `_id` " + _id + " does not exist");
              err.collection = _this.__collectionName;
              return cb(err);
            } else {
              if (schema && result) {
                result = schema.idsToStrings(result);
              }
              return cb(null, result);
            }
          });
        });
      };
    })(this));
  };

  BaseModel.prototype.updateByIds = function(ids, toUpdate, options, cb) {
    var selector;
    selector = {
      _id: {
        "$in": ids.map(this.ObjectID)
      }
    };
    return this.updateWithSelector(selector, toUpdate, options, cb);
  };

  BaseModel.prototype.updateWithSelector = function(selector, toUpdate, options, cb) {
    var ex;
    if (_.isFunction(options)) {
      cb = options;
      options = {};
    }
    options.multi = true;
    try {
      this.jsonSchema.partialValidate(toUpdate);
    } catch (_error) {
      ex = _error;
      return cb(ex);
    }
    toUpdate = this.jsonSchema.stringsToIds(toUpdate);
    return this.collection((function(_this) {
      return function(err, collection) {
        if (err) {
          return cb(err);
        }
        return collection.update(selector, {
          $set: toUpdate
        }, _.extend(options), function(err, result) {
          return process.nextTick(function() {
            if (err) {
              return cb(err);
            }
            return cb(null);
          });
        });
      };
    })(this));
  };

  BaseModel.prototype.updateWithSelectorNoValidation = function(selector, updateQuery, options, cb) {
    if (_.isFunction(options)) {
      cb = options;
      options = {};
    }
    return this.collection(function(err, collection) {
      if (err) {
        return cb(err);
      }
      return collection.update(selector, {
        $set: updateQuery
      }, _.extend({
        journal: true,
        getLastError: 1,
        multi: true
      }, options), function(err, result) {
        return process.nextTick(function() {
          return cb(err, result);
        });
      });
    });
  };

  /*
    Unsets the specified field in mongo. No safety checks,
    use at your own risk!
  
    @param id {String} Valid mongoId
    @param field {String}
    @param cb {Function}
   */

  BaseModel.prototype.unsetField = function(id, field, cb) {
    var err;
    if (!this.isObjectID(id)) {
      err = new Error("Invalid mongo id: " + id);
      err.collection = this.__collectionName;
      return cb(err);
    }
    id = this.ObjectID(id);
    return this.collection(function(err, collection) {
      var op;
      if (err) {
        return cb(err);
      }
      op = {
        $unset: {}
      };
      op.$unset[field] = "";
      return collection.update({
        _id: id
      }, op, cb);
    });
  };

  BaseModel.prototype.isObjectID = function(str) {
    var ex, o;
    if (str instanceof mongoObjectID) {
      return true;
    }
    if (!str) {
      return false;
    }
    try {
      o = new mongoObjectID(str.toString());
      return true;
    } catch (_error) {
      ex = _error;
      if (ex.message === 'Argument passed in must be a single String of 12 bytes or a string of 24 hex characters') {
        return false;
      }
      if (ex.message === 'Value passed in is not a valid 24 character hex string') {
        return false;
      }
      console.log("ex: ", ex);
      console.log("message: ", ex.message);
      throw ex;
    }
  };

  BaseModel.isObjectID = BaseModel.prototype.isObjectID;

  BaseModel.prototype.findAndModify = function(selector, updateQuery, options, cb) {
    if (_.isFunction(options)) {
      cb = options;
      options = {};
    }
    return this.collection((function(_this) {
      return function(err, collection) {
        if (err) {
          return cb(err);
        }
        return collection.findAndModify(selector, [["_id", "asc"]], updateQuery, _.extend({
          journal: true,
          getLastError: 1
        }, options), function(err, doc) {
          return process.nextTick(function() {
            if (!err && !doc) {
              return cb(new Error("Document using selector " + selector + " does not exist"));
            }
            if (_this.jsonSchema && doc) {
              doc = _this.jsonSchema.idsToStrings(doc);
            }
            doc = _this.__outputFormatter(doc);
            return cb(err, doc);
          });
        });
      };
    })(this));
  };

  BaseModel.prototype.findWithNoValidation = function(query, options, cb) {
    if (_.isFunction(options)) {
      cb = options;
      options = {};
    }
    return this.collection((function(_this) {
      return function(err, collection) {
        if (err) {
          return cb(err);
        }
        return collection.find(query, options).toArray(function(err, docs) {
          return process.nextTick(function() {
            if (_this.jsonSchema && docs) {
              docs = docs.map(function(doc) {
                return _this.jsonSchema.idsToStrings(doc);
              });
            }
            return cb(err, docs);
          });
        });
      };
    })(this));
  };

  BaseModel.prototype.find = function(query, options, cb) {
    if (_.isFunction(options)) {
      cb = options;
      options = {};
    }
    if (this.jsonSchema && JSON.stringify(query).indexOf("$") === -1) {
      query = this.jsonSchema.stringsToIds(query);
    }
    return _convertOidFields(this, query, (function(_this) {
      return function(err) {
        if (err) {
          return cb(err);
        }
        return _this.collection(function(err, collection) {
          if (err) {
            return cb(err);
          }
          return collection.find(query, options).toArray(function(err, docs) {
            return process.nextTick(function() {
              docs = _this.__outputFormatter(docs);
              return cb(err, docs);
            });
          });
        });
      };
    })(this));
  };

  BaseModel.prototype.findOne = function(query, options, cb) {
    if (_.isFunction(options)) {
      cb = options;
      options = {};
    }
    return _convertOidFields(this, query, (function(_this) {
      return function(err) {
        if (err) {
          return cb(err);
        }
        return _this.collection(function(err, collection) {
          if (err) {
            return cb(err);
          }
          return collection.find(query, options).nextObject(function(err, doc) {
            if (err) {
              return cb(err);
            }
            if (!doc) {
              return cb(NotFoundError({
                query: query,
                collection: _this.__collectionName
              }));
            }
            return process.nextTick(function() {
              if (_this.jsonSchema && doc) {
                doc = _this.jsonSchema.idsToStrings(doc);
              }
              if (doc && _this.__outputFormatter) {
                doc = _this.__outputFormatter(doc);
              }
              return cb(err, doc);
            });
          });
        });
      };
    })(this));
  };

  BaseModel.prototype.findById = function(id, cb) {
    var err;
    if (!this.isObjectID(id)) {
      err = new Error("Invalid mongo id: " + id);
      err.collection = this.__collectionName;
      return cb(err);
    }
    id = this.ObjectID(id);
    return this.findOne({
      _id: id
    }, (function(_this) {
      return function(err, result) {
        if (err) {
          return cb(err);
        }
        if (_this.__outputFormatter) {
          result = _this.__outputFormatter(result);
        }
        return cb(null, result);
      };
    })(this));
  };

  BaseModel.prototype.findByIds = function(ids, cb) {
    ids = ids.map((function(_this) {
      return function(id) {
        return _this.ObjectID(id);
      };
    })(this));
    return this.findWithNoValidation({
      _id: {
        $in: ids
      }
    }, (function(_this) {
      return function(err, docs) {
        if (err) {
          return cb(err);
        }
        if (_this.__outputFormatter) {
          docs = docs.map(_this.__outputFormatter);
        }
        return cb(null, docs);
      };
    })(this));
  };

  BaseModel.prototype.remove = function(query, cb) {
    if (!cb || !_.isFunction(cb)) {
      throw new Error("remove() expects a callback");
    }
    var that = this;
    return _convertOidFields(this, query, function(err) {
      if (err) {
        return cb(err);
      }
      that.collection(function(err, collection) {
        var _ref, _ref1;
        if (err) {
          return cb(err);
        }
        return collection.remove(query, {
          journal: true,
          w: 1
        }, function(err) {
          return process.nextTick(function() {
            return cb(err);
          });
        });
      });
    });
  };

  BaseModel.prototype.removeById = function(id, cb) {
    var ex;
    if (!cb || !_.isFunction(cb)) {
      throw new Error("removeById() expects a callback");
    }
    try {
      id = this.ObjectID(id);
    } catch (_error) {
      ex = _error;
      return cb(ex);
    }
    return this.collection(function(err, collection) {
      if (err) {
        return cb(err);
      }
      return collection.remove({
        _id: id
      }, {
        journal: true,
        w: 1
      }, function(err) {
        return process.nextTick(function() {
          return cb(err);
        });
      });
    });
  };

  BaseModel.prototype.count = function(query, cb) {
    return _convertOidFields(this, query, (function(_this) {
      return function(err) {
        if (err) {
          return cb(err);
        }
        return _this.collection(function(err, collection) {
          if (err) {
            return cb(err);
          }
          return collection.count(query, function(err, count) {
            if (err) {
              return cb(err);
            }
            return cb(null, count);
          });
        });
      };
    })(this));
  };

  BaseModel.prototype.error = {
    invalidMongoId: InvalidMongoIdError = function(detail) {
      var error;
      error = new Error();
      error.message = 'Invalid mongo id';
      return decorateError(error, 'InvalidMongoId', detail);
    },
    notFound: NotFoundError = function(detail) {
      var error;
      error = new Error();
      error.message = 'Not found';
      return decorateError(error, 'NotFound', detail);
    },
    duplicateKey: DuplicateKeyError = function(detail) {
      var error;
      error = new Error();
      error.message = 'Duplicate Key';
      return decorateError(error, 'DuplicateKey', detail);
    }
  };

  return BaseModel;

})();

BaseModel.ObjectID = BaseModel.prototype.ObjectID;

module.exports = BaseModel;


/*

  private fns
 */

var _validateSomeFields = function(me, object, cb) {
  var fieldsToTest, model;
  fieldsToTest = Object.keys(object);
  return async.eachSeries(Object.keys(object), function(v, next) {
    return me.__schema.validateField(v, model, next);
  }, cb);
};

var _convertOidFields = function(me, objects, cb) {
  var e, field, object, _i, _j, _len, _len1, _ref;
  if (!_.isArray(objects)) {
    objects = [objects];
  }
  for (_i = 0, _len = objects.length; _i < _len; _i++) {
    object = objects[_i];
    if (me.__oidFields) {
      _ref = me.__oidFields;
      for (_j = 0, _len1 = _ref.length; _j < _len1; _j++) {
        field = _ref[_j];
        try {
          if (!!object[field] && !(object[field] instanceof mongoObjectID) && !(_.isObject(object[field]))) {
            object[field] = mongoObjectID(String(object[field]));
          }
        } catch (_error) {
          e = _error;
          return cb(new Error("Must provide a valid MongoId for `" + field + "`"));
        }
      }
    }
  }
  return cb(null);
};

var _validateAllFields = function(me, docs, cb) {
  if (!_.isArray(docs)) {
    docs = [docs];
  }
  return async.eachSeries(docs, function(obj, next) {
    var model;
    model = new Bindable.Object(obj);
    return me.__schema.validate(model, next);
  }, cb);
};

var _sanitizeDocuments = function(me, docs) {
  var isArray, ne;
  if (!(isArray = _.isArray(docs))) {
    docs = [docs];
  }
  ne = _.each(docs, function(doc) {
    return _.pick(_.omit(doc, '_id'), me.__fields);
  });
  if (!isArray) {
    return ne.shift();
  } else {
    return ne;
  }
};

var oidTest = function(name) {
  return [
    {
      test: function(v, next) {
        if (!v instanceof mongoObjectID) {
          return next(new Error("`" + name + "` not an ObjectID"));
        } else {
          return next();
        }
      },
      message: "`" + name + "` must be an ObjectID"
    }
  ];
};

var decorateError = function(err, type, detail) {
  Object.defineProperty(err, 'type', {
    value: type,
    enumerable: true,
    writable: true,
    configurable: true
  });
  Object.defineProperty(err, type, {
    value: true,
    enumerable: true,
    writable: true,
    configurable: true
  });
  if (detail) {
    Object.defineProperty(err, 'detail', {
      value: detail,
      enumerable: true,
      writable: true,
      configurable: true
    });
  }
  return err;
};


