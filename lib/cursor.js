const _ = require('lodash');
const Promise = require('bluebird');

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
        self.set('elasticsearch', {
          query: s
        });
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
        self.set('elasticsearch', {
          query: s,
          autocomplete: true
        });
      },
      finalize: function() {
      },
      safeFor: 'public',
      launder: function(s) {
        return self.apos.launder.string(s);
      }
    });

    let superLowLevelMongoCursor = self.lowLevelMongoCursor;

    self.lowLevelMongoCursor = function(req, criteria, projection, options) {
      const elasticsearch = self.get('elasticsearch');
      const workflow = self.apos.modules['apostrophe-workflow'];
      const batchSize = 50;
      if (!elasticsearch) {
        return superLowLevelMongoCursor(req, criteria, projection, options);
      }
      const module = self.apos.modules['apostrophe-elasticsearch'];
      // Meld in some of the simpler non-search criteria from the mongo query so we
      // can winnow things down faster. This doesn't result in exact matches only,
      // but that's OK as long as it doesn't leave anything out; we are still
      // feeding relevant results to mongo sooner and thus speeding it up
      const queries = self.elasticsearchDiscoverQueries(req, criteria);
      let ids = null;
      if (queries._id) {
        ids = queries._id;
        delete queries._id;
      }
      const esCriteria = {
        index: module.getLocaleIndex(workflow ? req.locale : 'default'),
        body: self.esGetQueryBody(elasticsearch, queries),
        from: 0,
        size: batchSize
      };
      if (ids) {
        esCriteria.body.query.bool.filter.push({
          ids: {
            values: ids
          }
        });
      }
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
        let docs = [];
        return nextBatch();
        function nextBatch() {
          return module.client.search(esCriteria, function(err, response) {
            if (err) {
              if (err.status === 404) {
                // There just aren't any indexed docs yet
                self.apos.utils.warn('apostrophe-elasticsearch: no indexed docs yet, run the apostrophe-elasticsearch:reindex task once');
                return callback(null, []);
              }
              return callback(err);
            }
            if (!(response.hits && response.hits.total)) {
              return callback(null, []);
            }
            const ids = _.map(response.hits.hits, '_id');
            let ignoreBatch = false;
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
                const skip = options.skip || 0;
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

    self.esGetQueryBody = function(elasticsearch, queries) {
      return {
        query: {
          bool: {
            must: [
              elasticsearch.autocomplete ? self.esGetAutocompleteQuery(elasticsearch) : self.esGetSearchQuery(elasticsearch)
            ],
            filter: _.map(queries, function(value, field) {
              const obj = {
                terms: {}
              };
              obj.terms[field + 'ESExact'] = value;
              return obj;
            })
          }
        }
      };
    };

    self.esGetAutocompleteQuery = function(elasticsearch) {
      return {
        multi_match: {
          type: 'phrase_prefix',
          query: elasticsearch.query,
          // This is where boosting becomes a possibility
          fields: self.getBoostedFields()
        }
      };
    };

    self.esGetSearchQuery = function(elasticsearch) {
      // We don't want the default operator to be AND because if a naive
      // user types in:
      //
      // `kindergarten gathering`
      //
      // We want them to see results with both, followed by results for either,
      // not exclusively results with both.
      //
      // However, to further match Google's behavior, we want this search to
      // exclude everything with `swedish`:
      //
      // `kindergarten gathering -swedish`
      //
      // To do that we have to force the AND operator, transforming it to:
      //
      // `kindergarten gathering +-swedish`
      //
      // The implementation has to respect quoted strings and escaped quotes. See:
      //
      // https://stackoverflow.com/a/23667311/389684

      const query = elasticsearch.query.replace(/\\"|"(?:\\"|[^"])*"|(-)/g, function(m, group1) {
        if (!group1) {
          return m;
        } else {
          return '+-';
        }
      });

      return {
        simple_query_string: {
          query: query,
          fields: self.getBoostedFields()
        }
      };

    };

    self.getBoostedFields = function() {
      const module = self.apos.modules['apostrophe-elasticsearch'];
      const boosts = module.options.boosts || {};
      return _.map(module.fields, function(field) {
        return boosts[field] ? (field + '^' + boosts[field]) : field;
      });
    };

    const superToDistinct = self.toDistinct;
    self.toDistinct = function(s, callback) {
      if (!self.get('elasticsearch')) {
        return superToDistinct.apply(self, arguments);
      }
      if (callback) {
        return body(callback);
      } else {
        return Promise.promisify(body)();
      }
      function body(callback) {
        // in terms of toArray, with cheap projection
        const projection = {};
        projection[s] = 1;
        return self.clone().projection(projection).toArray(function(err, docs) {
          if (err) {
            return callback(err);
          }
          if (self.get('distinctCounts')) {
            const counts = {};
            _.each(docs, function(doc) {
              if (Array.isArray(doc[s])) {
                _.each(doc[s], function(v) {
                  counts[v] = counts[v] || 0;
                  counts[v]++;
                });
              } else {
                counts[doc[s]] = counts[doc[s]] || 0;
                counts[doc[s]]++;
              }
            });
            self.set('distinctCounts', counts);
          }
          return callback(null, _.uniq(_.flatten(_.map(docs, s))));
        });
      }
    };

    const superToCount = self.toCount;
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
        const projection = { _id: 1 };
        return self.clone().skip(undefined).limit(undefined).page(undefined).perPage(undefined).projection(projection).toArray(function(err, docs) {
          if (err) {
            return callback(err);
          }
          // At some point, it would be nice to do an apos PR to factor this out
          // so we can call it rather than duplicating it
          if (self.get('perPage')) {
            const perPage = self.get('perPage');
            let totalPages = Math.floor(docs.length / perPage);
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
    // to be passed on to elasticsearch so we don't waste as much time winnowing
    // output that matches the text search but not the other criteria

    self.elasticsearchDiscoverQueries = function(req, criteria) {
      let queries = {};

      discoverKeys(criteria);

      function discoverKeys(criteria) {
        _.each([ '_id', 'slug', 'path', 'type', 'tags' ], function(key) {
          const val = criteria[key];
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

  }
};
