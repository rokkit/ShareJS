var hat = require('hat');
var livedb = require('livedb');
var Transform = require('stream').Transform;
var EventEmitter = require('events').EventEmitter;

var UserAgent = function(instance, stream) {
  if (!(this instanceof UserAgent)) return new UserAgent(instance, stream);

  this.instance = instance;
  this.backend = instance.backend;

  this.stream = stream;
  this.sessionId = hat();

  this.connectTime = new Date();
};

module.exports = UserAgent;

/**
 * Helper to run the filters over some data. Returns an error string on error,
 * or nothing on success.  Data is modified.
 *
 * Synchronous.
 */
UserAgent.prototype._runFilters = function(filters, collection, docName, data) {
  try {
    for (var i = 0; i < filters.length; i++) {
      var err = filters[i].call(this, collection, docName, data);
      if (err) return err;
    }
  } catch (e) {
    console.warn('filter threw an exception. Bailing.');
    console.error(e.stack);
    return e.message;
  }
};

UserAgent.prototype.filterDoc = function(collection, docName, data) {
  return this._runFilters(this.instance.docFilters, collection, docName, data);
};
UserAgent.prototype.filterOp = function(collection, docName, data) {
  return this._runFilters(this.instance.opFilters, collection, docName, data);
};

/** Helper to trigger actions */
UserAgent.prototype.trigger = function(action, collection, docName, extraFields, callback) {
  if (typeof extraFields === 'function') {
    callback = extraFields;
    extraFields = {};
  }

  var request = extraFields;
  request.action = action;
  request.collection = collection;
  request.docName = docName;
  request.backend = this.backend;

  this.instance._trigger(request, callback);
};

UserAgent.prototype.fetch = function(collection, docName, callback) {
  var agent = this;
  var action = actionForDoc();

  agent.trigger('fetch', collection, docName, function(err, action) {
    if (err) return callback(err);
    collection = action.collection;
    docName = action.docName;

    agent.backend.fetch(collection, docName, function(err, data) {
      if (err) return callback(err);

      if (data) {
        err = agent.filterDoc(collection, docName, data);
      }
      callback(err, err ? null : data);
    });
  });
};

UserAgent.prototype.getOps = function(collection, docName, start, end, callback) {
  var agent = this;

  agent.trigger('getOps', collection, docName, {start:start, end:end}, function(err, action) {
    if (err) return callback(err);

    agent.backend.getOps(action.collection, action.docName, start, end, function(err, results) {
      if (err) return callback(err);

      if (results) {
        for (var i = 0; i < results.length; i++) {
          err = agent.filterOp(collection, docName, results[i]);

          // If there's an error, throw away all the results and return the error to the client.
          if (err) callback(err);
        }
      }
      callback(null, results);
    });
  });
};

/** Helper function to filter & rewrite wrap a stream of operations */
UserAgent.prototype.wrapOpStream = function(collection, docName, stream) {
  var agent = this;
  var passthrough = new Transform({objectMode:true});

  passthrough._transform = function(data, encoding, callback) {
    var err = agent.filterOp(collection, docName, data);
    if (err) {
      passthrough.push({error:err});
    } else {
      passthrough.push(data);
    }
    callback();
  };

  passthrough.destroy = function() { stream.destroy(); };

  stream.pipe(passthrough);

  return passthrough;
};

UserAgent.prototype.subscribe = function(collection, docName, version, callback) {
  var agent = this;
  agent.trigger('subscribe', collection, docName, {version:version}, function(err, action) {
    if (err) return callback(err);
    collection = action.collection;
    docName = agent.docName;
    agent.backend.subscribe(action.collection, action.docName, action.version, function(err, stream) {
       callback(err, err ? err : agent.wrapOpStream(collection, docName, stream));
    });
  });
};

UserAgent.prototype.fetchAndSubscribe = function(collection, docName, callback) {
  var agent = this;
  agent.trigger('fetch', collection, docName, function(err, action) {
    if (err) return callback(err);
    agent.trigger('subscribe', action.collection, action.docName, function(err, action) {
      if (err) return callback(err);

      collection = action.collection;
      docName = agent.docName;
      agent.backend.fetchAndSubscribe(action.collection, action.docName, function(err, data, stream) {
        if (!err && data) err = agent.filterDoc(collection, docName, data);

        if (err) return callback(err);

        var stream = agent.wrapOpStream(collection, docName, stream);
        callback(null, data, stream);
      });
    });
  });
};

UserAgent.prototype.submit = function(collection, docName, opData, callback) {
  var agent = this;
  agent.trigger('submit', collection, docName, {opData:opData}, function(err, action) {
    if (err) return callback(err);

    collection = action.collection;
    docName = action.docName;
    opData.validate = function(opData, snapshot, callback) {
      agent.trigger('validate', collection, docName, {opData:opData, snapshot:snapshot}, callback);
    };

    agent.backend.submit(action.collection, action.docName, action.opData, callback);
  });
};

/** Helper to filter query result sets */
UserAgent.prototype._filterQueryResults = function(collection, results) {
  for(var i = 0; i < results.length; i++) {
    console.log(results[i]);
    var err = this.filterDoc(collection, results[i].docName, results[i]);

    // If there's an error, throw away all the results. You can't have 'em!
    if (err) return err;
  }
};

UserAgent.prototype.queryFetch = function(collection, query, callback) {
  var agent = this;
  // Should we emit 'query' or 'query fetch' here?
  agent.trigger('query', collection, query, {fetch:true}, function(err, action) {
    if (err) return callback(err);

    collection = action.collection;
    query = action.query;

    agent.backend.queryFetch(collection, query, function(err, results) {
      if (!err && results) err = agent._filterQueryResults(collection, results);
      callback(err, err ? err : results);
    });
  });
};

UserAgent.prototype.query = function(collection, query, options, callback) {
  var agent = this;
  agent.trigger('query', collection, null, {query:query, options:options}, function(err, action) {
    if (err) return callback(err);

    collection = action.collection;
    query = action.query;

    console.log('query', query);
    agent.backend.query(collection, query, options, function(err, emitter) {
      if (!err && emitter) err = agent._filterQueryResults(collection, emitter.data);
      if (err) return callback(err);

      // Wrap the query result event emitter
      var wrapped = new EventEmitter();
      wrapped.data = emitter.data;

      emitter.on('add', function(data, idx) {
        var err = agent.filterDoc(collection, data.docName, data);
        if (err)
          wrapped.emit('error', err);
        else 
          wrapped.emit('add', data, idx);
      });
      emitter.on('remove', function(data, idx) {
        // Don't need to filter out the remove.
        wrapped.emit('remove', data, idx);
      });

      callback(null, wrapped);
    });
  });
};

// 'query', 


// filter snapshot
// filter op
// validate new data


