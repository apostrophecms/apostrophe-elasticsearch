var _ = require('lodash');
var Promise = require('bluebird');

module.exports = {
  construct: function(self, options) {
    self.addFilter('search', {
      def: '__THISISNOTAREALDEFAULT',
      set: function(s) {
        if (s === '__THISISNOTAREALDEFAULT') {
          // Don't let the defaults mechanism ruin our attempt to
          // sidestep the usual 'search' state property and its
          // side effects
          return;
        }
        if (!s.length) {
          self.set('elasticsearch', false);
          return;
        }
        self.set('elasticsearch', s);
      },
      finalize: function() {
      },
      safeFor: 'public',
      launder: function(s) {
        return self.apos.launder.string(s);
      }
    });
    self.addFilter('autocomplete', {
      def: '__THISISNOTAREALDEFAULT',
      set: function(s) {
        if (s === '__THISISNOTAREALDEFAULT') {
          // Don't let the defaults mechanism ruin our attempt to
          // sidestep the usual 'search' state property and its
          // side effects
          return;
        }
        if (!s.length) {
          self.set('elasticsearch', false);
          return;
        }
        self.set('elasticsearch', s + '*');
      },
      finalize: function() {
      },
      safeFor: 'public',
      launder: function(s) {
        return self.apos.launder.string(s);
      }
    });

    var superLowLevelMongoCursor = self.lowLevelMongoCursor;

    self.lowLevelMongoCursor = function(req, criteria, projection, options) {
      var elasticsearch = self.get('elasticsearch') || self.get('elasticautocompletesearch');

      var batchSize = 50;
      if (!elasticsearch) {
        return superLowLevelMongoCursor(req, criteria, projection, options);
      }
      var module = self.apos.modules['apostrophe-elasticsearch'];
      var q = '(' + elasticsearch + ')';
      // Meld in some of the simpler non-search criteria from the mongo query so we
      // can winnow things down faster. This doesn't result in exact matches only,
      // but that's OK as long as it doesn't leave anything out; we are still
      // feeding relevant results to mongo sooner and thus speeding it up
      var queries = self.elasticsearchDiscoverQueries(req, criteria)
      _.each(queries, function(value, field) {
        if (field === 'locale') {
          // q += ' AND (workflowLocale:' + e(value) +' OR _missing_:workflowLocale)';
        } else {
          q += ' AND (' + _.map(value, function(v) {
            return '(' + field + ':' + e(v) + ')';
          }).join(' OR ') + ')';
        }
      });
      function e(value) {
        return '"' + value.replace(/\"/g, '\\"') + '"';
      }
      console.log(q);
      var esCriteria = {
        index: module.docIndex,
        q: q,
        from: 0,
        size: batchSize,
      };
      return {
        toArray: function(callback) {
          if (!callback) {
            return Promise.promisify(body)();
          }
          return body(callback);
        },
        count: function(callback) {
          if (!callback) {
            return Promise.promisify(counter)();
          }
          return counter(callback);
          function counter(callback) {
            return body(function(err, docs) {
              if (err) {
                return callback(err);
              }
              return callback(null, docs.length);
            });
          }
        }
      };
      function body(callback) {
        var docs = [];
        return nextBatch();
        function nextBatch() {
          return module.client.search(esCriteria, function(err, response) {
            if (err) {
              if (err.status === 404) {
                // There just aren't any indexed docs yet
                self.apos.utils.warn('apostrophe-elasticsearch: no indexed docs yet, run the apostrophe-elasticsearch:index task once');
                return callback(null, []);
              }
              return callback(err);
            }
            if (!(response.hits && response.hits.total)) {
              return callback(null, []);
            }
            var ids = _.map(response.hits.hits, '_id');
            var ignoreBatch = false;
            if (_.isNumber(options.skip) && (docs.length + ids.length <= options.skip)) {
              ignoreBatch = true;
            }
            return superLowLevelMongoCursor(req, {
              $and: [
                {
                  _id: {
                    $in: ids
                  }
                },
                criteria
              ]
            }, ignoreBatch ? { _id: 1 } : projection, {}).toArray(function(err, results) {
              if (err) {
                return callback(err);
              }
              if (!results.length) {
                return winnow();
              }
              results = self.apos.utils.orderById(ids, results);
              docs = docs.concat(results);
              if (_.isNumber(options.limit)) {
                var skip = options.limit || 0;
                if (docs.length > skip + options.limit) {
                  return winnow();
                }
              }
              esCriteria.from += batchSize;
              return nextBatch();
            });
          });
        }
        function winnow() {
          if (_.isNumber(options.skip)) {
            docs = docs.slice(options.skip);
          }
          if (_.isNumber(options.limit)) {
            docs = docs.slice(0, options.limit);
          }
          return callback(null, docs);
        }
      }
    };

    var superToDistinct = self.toDistinct;
    self.toDistinct = function(s, callback) {
      if (!self.get('elasticsearch')) {
        return superToDistinct.apply(arguments);
      }
      if (callback) {
        return body(callback);
      } else {
        return Promise.promisify(body)();
      }
      function body(callback) {
        // in terms of toArray, with cheap projection
        var projection = {};
        projection[s] = 1;
        return self.clone().projection(projection).toArray(function(err, docs) {
          if (err) {
            return callback(err);
          }
          if (self.get('distinctCounts')) {
            var counts = {};
            _.each(docs, function(doc) {
              counts[doc[s]] = counts[doc[s]] || 0;
              counts[doc[s]]++;
            });
            self.set('distinctCounts', counts);
          }
          return callback(null, _.uniq(_.map(docs, s)));
        });
      }
    };

    var superToCount = self.toCount;
    self.toCount = function(callback) {
      if (!self.get('elasticsearch')) {
        return superToCount.apply(self, arguments);
      }
      if (callback) {
        return body(callback);
      } else {
        return Promise.promisify(body)();
      }
      function body(callback) {
        // in terms of toArray, with cheap projection
        var projection = { _id: 1 };
        return self.clone().skip(undefined).limit(undefined).page(undefined).perPage(undefined).projection(projection).toArray(function(err, docs) {
          if (err) {
            return callback(err);
          }
          // At some point, it would be nice to do an apos PR to factor this out
          // so we can call it rather than duplicating it
          if (self.get('perPage')) {
            var perPage = self.get('perPage');
            var totalPages = Math.floor(docs.length / perPage);
            if (docs.length % perPage) {
              totalPages++;
            }
            self.set('totalPages', totalPages);
          }
          return callback(null, docs.length);
        });
      }
    };

    // Discovers simple, unique key-driven queries within the given criteria
    // object that set an outer bound on what that criteria object could return,
    // and adds them to req.optimize.nextQueries for future prefetches of
    // the current URL

    self.elasticsearchDiscoverQueries = function(req, criteria) {
      var queries = {};
      queries.locale = self.elasticsearchDiscoverQueryLocale(req, criteria) || '__none';

      discoverKeys(criteria);

      function discoverKeys(criteria) {
        _.each([ '_id', 'slug', 'path', 'type', 'tags' ], function(key) {
          var val = criteria[key];
          if (typeof (val) === 'string') {
            queries[key] = queries[key] || [];
            queries[key].push(val);
          } else if (val && val.$in && Array.isArray(val.$in)) {
            queries[key] = queries[key] || [];
            queries[key] = queries[key].concat(val.$in);
          }
        });
        if (criteria.$and) {
          _.each(criteria.$and, function(clause) {
            discoverKeys(clause);
          });
        }
      }
      return queries;
    };

    // If workflow is in play it can be a big perf wine to constrain queries by slug and path
    // by locale, if this was done in the original query
    self.elasticsearchDiscoverQueryLocale = function(req, criteria) {
      var locale;
      // Detect the special $or clause that checks for a locale, or for a doc that doesn't have a locale
      if (criteria.$or && (criteria.$or.length === 2) && criteria.$or[0].workflowLocale && criteria.$or[1].workflowLocale) {
        return criteria.$or[0].workflowLocale;
      }
      if (criteria.$and) {
        _.each(criteria.$and, function(clause) {
          locale = self.elasticsearchDiscoverQueryLocale(req, clause);
          if (locale) {
            return false;
          }
        });
      }
      return locale;
    };    

  }
};
